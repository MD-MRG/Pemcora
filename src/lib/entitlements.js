// What a team has: its plan, its packs and how much of its allowance is used
// (build plan 2.3 to 2.6, and 2.11). Read from team_entitlements() when the app
// opens and after each visit starts. The last answer is kept per team, so a device
// with no signal still shows the right pages.
//
// This only explains the limits. The database enforces them, and can say no to
// something this thinks is fine, or yes to a second device joining an open visit
// with the allowance used up. So nothing here stops a request from being made.
//
// Not knowing means no restrictions. null is what the headless suites see, and a
// project without the function, and nothing is hidden from them.

import * as api from './api.js'
import { heldVisits, retryHeld } from './cache.js'
import { prefs } from './prefs.js'
import { isNetworkFailure } from './saveErrors.js'
import { PACKS, offeredPacks, packById, workflow } from '../data/packs/index.js'

// The allowance runs by the calendar month in Sydney, whatever the device's clock
// says about where it is (2.5).
const SYDNEY = 'Australia/Sydney'

const state = { teamId: null, userId: null, source: api, value: null, confirmation: null }
const listeners = new Set()

const emit = () => listeners.forEach(fn => fn())

export function subscribeEntitlements(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const currentEntitlements = () => state.value

/** The team the app has just opened on. Answers at once with what this device last
 *  knew about it, and resolves when the database has had its say. */
export function openEntitlements(teamId, userId, source = api) {
  Object.assign(state, {
    teamId,
    userId,
    source,
    value: prefs.getLastEntitlements(userId, teamId),
    confirmation: null,
  })
  emit()
  return refreshEntitlements()
}

/** Asks again. Failing keeps what is known: this is never worth an error on screen. */
export async function refreshEntitlements() {
  const { teamId, userId, source } = state
  if (!teamId) return null
  try {
    const value = await source.getEntitlements(teamId)
    // Answering for a team this device has since switched away from.
    if (state.teamId !== teamId) return state.value
    state.value = value
    prefs.setLastEntitlements(userId, teamId, value)
    emit()
  } catch (e) {
    if (!isNetworkFailure(e)) console.error('[entitlements] could not read them', e)
  }
  return state.value
}

/** The team whose plan is open: the one the app is working in. Null with no team, as in local-only mode. */
export const entitledTeam = () => state.teamId

export function closeEntitlements() {
  Object.assign(state, { teamId: null, userId: null, source: api, value: null, confirmation: null })
  emit()
}

/* ── What the team may do ─────────────────────────────────────────────────── */

export const isProvider = e => !e || e.accountType === 'provider'

export const holdsPack = (e, packId) => !e || packId === 'core' || e.packs.includes(packId)

/**
 * Does this team work under this pack: see its pages, give rooms its types? A pack
 * whose lists a licensed electrician hasn't checked yet (`proposed`) is never
 * assumed, even not knowing: only a team known to hold it sees it.
 */
export const usesPack = (e, packId) =>
  packById(packId)?.proposed ? !!e?.packs?.includes(packId) : holdsPack(e, packId)

/** The types this team's rooms can be given, from the packs it uses, none twice. */
export function roomTypesFor(e) {
  const types = new Map()
  for (const pack of PACKS) {
    if (!usesPack(e, pack.id)) continue
    for (const type of pack.roomTypes ?? []) if (!types.has(type.id)) types.set(type.id, type)
  }
  return [...types.values()]
}

/** The month's inspections, while the limits are on and this team has a limit. */
export function allowance(e) {
  if (!e?.enforced || e.visitLimit === null) return null
  return {
    limit: e.visitLimit,
    // Visits are counted with the limits off too, so this can start out past it.
    used: Math.min(e.visitsUsed, e.visitLimit),
    usedUp: e.visitsUsed >= e.visitLimit,
  }
}

/** Should the Start button say so? It still asks the database when pressed: a second
 *  device can join an open visit with the allowance used up (2.5). */
export function startNeedsUpgrade(e, kind) {
  return !!allowance(e)?.usedUp || (!!e?.enforced && !holdsPack(e, workflow(kind).packId))
}

/** What the starter pack could be swapped for: nothing for a team without one, or
 *  once a visit has started under it (2.3). choose_starter_pack() has the last word. */
export function swapTargets(e) {
  if (!e?.starterPack || e.starterInUse) return []
  return offeredPacks().filter(pack => !e.packs.includes(pack.id))
}

export async function swapStarterPack(packId) {
  await state.source.chooseStarterPack(state.teamId, packId)
  await refreshEntitlements()
}

const NO_TEAM_YET = 'Inspections and reports'

/** The line under the name on the brand plate: what this team does. */
export function brandTagline(e) {
  if (!e) return NO_TEAM_YET
  if (!isProvider(e)) return 'Property compliance'
  const pack = packById(e.starterPack ?? e.packs.find(id => id !== 'core'))
  return pack?.tagline ?? NO_TEAM_YET
}

/* ── Dates ────────────────────────────────────────────────────────────────── */

const dayLabel = (date, month, timeZone = SYDNEY) =>
  date.toLocaleDateString('en-AU', { day: 'numeric', month, timeZone })

// The 1st of next month, in Sydney. Built in UTC and read back in UTC, because it
// names a day on the calendar rather than a moment.
function nextReset(now) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: SYDNEY,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now)
  const part = type => Number(parts.find(p => p.type === type).value)
  // `month` counts from 1, which makes it next month's index for Date.UTC.
  return new Date(Date.UTC(part('year'), part('month'), 1))
}

export const resetDay = (month, now = new Date()) => dayLabel(nextReset(now), month, 'UTC')

/** "1 of 1 free inspection used this month · resets 1 Dec" */
export function usageLine(e, now = new Date()) {
  const left = allowance(e)
  if (!left) return null
  const noun = left.limit === 1 ? 'inspection' : 'inspections'
  return `${left.used} of ${left.limit} free ${noun} used this month · resets ${resetDay('short', now)}`
}

/* ── Banners (2.6) ────────────────────────────────────────────────────────── */

/** What the app has to say about the plan, while it's still true. */
export function planBanners(e, now = new Date()) {
  if (!e) return []
  const ahead = iso => !!iso && new Date(iso) > now
  const banners = []
  if (ahead(e.pastDueUntil)) {
    banners.push({
      kind: 'past-due',
      title: `The last payment for Pro didn't go through. Update the card by ${dayLabel(new Date(e.pastDueUntil), 'long')}, or this team moves to the Free plan.`,
    })
  }
  if (ahead(e.cancelAt)) {
    banners.push({ kind: 'cancelling', title: `Pro ends on ${dayLabel(new Date(e.cancelAt), 'long')}.` })
  }
  return banners
}

/* ── The upgrade sheet (2.11) ─────────────────────────────────────────────── */

const PRO_ADDS = ['Unlimited inspections', 'Photos', 'Your logo on reports', 'Re-check reminders']

const KEPT = 'Anything you\'ve entered is kept and saves once you upgrade.'

function allowanceSheet(e, now) {
  const limit = e?.visitLimit ?? null
  const what =
    limit === 1
      ? 'this month\'s free inspection'
      : limit > 1
        ? `this month's ${limit} free inspections`
        : 'this month\'s free inspections'
  return {
    title: `You've used ${what}`,
    lines: [`Your next free inspection comes on ${resetDay('long', now)}.`],
    adds: PRO_ADDS,
    kept: KEPT,
    action: 'Upgrade to Pro',
    ask: 'to upgrade',
  }
}

/** A photo the plan refused. The item itself saved: only the photo didn't. */
export const photoSheet = () => ({
  title: 'Photos are part of Pro',
  lines: ['A photo of the label keeps its details with the item. The item itself is saved without it.'],
  adds: PRO_ADDS,
  action: 'Upgrade to Pro',
  ask: 'to upgrade',
})

function packSheet(e, packId) {
  const label = packById(packId)?.label ?? packId
  const canSwap = swapTargets(e).some(pack => pack.id === packId)
  return {
    swap: canSwap
      ? {
          packId,
          line: `This team hasn't started a visit under ${packById(e.starterPack)?.label}, so you can still swap it for this one.`,
          action: `Swap to ${label}`,
        }
      : null,
    title: `This team doesn't have the ${label} pack`,
    lines: [
      `New ${label} visits need the pack. Past visits, reports and due dates all stay as they are.`,
    ],
    adds: [],
    kept: 'Anything you\'ve entered is kept and saves once the pack is added.',
    action: `Add ${label}`,
    ask: 'to add it',
  }
}

/** A visit the plan refused. The refusal's code says it was the plan, and what the
 *  team holds says which part of it. Never the message text. */
export function visitSheet(e, kind, now = new Date()) {
  const packId = workflow(kind).packId
  return holdsPack(e, packId) ? allowanceSheet(e, now) : packSheet(e, packId)
}

/** A team with no seat left, when inviting someone or moving them in. `plan` is that
 *  team's own: it needn't be the one the app is working in. */
export function seatSheet(teamName, plan) {
  const lines = [
    'Every seat on its plan is taken or already invited. Nobody can be added until there is one free.',
  ]
  const title = `${teamName ?? 'This team'} is full`
  return plan?.isPro
    ? { title, lines, adds: [], action: 'Add seats', ask: 'to add seats' }
    : { title, lines, adds: ['More people in your team', ...PRO_ADDS], action: 'Upgrade to Pro', ask: 'to upgrade' }
}

/**
 * What "Upgrade to Pro" does. Step E1 points this at Stripe Checkout, and calls
 * afterUpgrade() when someone comes back having paid. Nobody can get here on the live
 * site before then: nothing is refused while enforce_limits is off, and that stays
 * off until E6.
 */
export async function startUpgrade() {
  return { outcome: 'not-yet' }
}

export const upgradeConfirmation = () => state.confirmation

export function dismissUpgradeConfirmation() {
  state.confirmation = null
  emit()
}

/**
 * Back from paying: find out what the team has now, save what was waiting on it, and
 * say so. Only what the plan refused goes again. A visit refused over its date, say,
 * will be refused the same way and stays on the list until someone deals with it.
 */
export async function afterUpgrade() {
  const fresh = await refreshEntitlements()
  const waiting = Object.entries(heldVisits())
    .filter(([, record]) => record.reason === 'upgrade')
    .map(([id]) => id)

  let saved = 0
  for (const id of waiting) {
    const landed = await retryHeld(id)
    if (landed && !heldVisits()[id]) saved += 1
  }

  if (fresh?.isPro) {
    state.confirmation =
      saved > 1
        ? `You're on Pro. Your ${saved} visits are saved.`
        : saved === 1
          ? 'You\'re on Pro. Your visit is saved.'
          : 'You\'re on Pro.'
    emit()
  }
  return { saved, waiting: waiting.length }
}
