// The team's data, held in memory, and the seam that decides where it lives.
//
// Why this exists at all:
//
// The three stores are synchronous — `listClients()` returns data, it does not
// return a promise. Every page reads during render on that assumption. Supabase
// is asynchronous, so pointing the stores straight at it would turn every read
// into a promise and ripple a refactor through all eight consumer files.
//
// So the whole team state is loaded once, kept in memory, and served
// synchronously from there. Writes update memory immediately — the UI never
// waits — and are pushed to the backend in the background. For one technician
// with a few hundred records, often on a bad connection, that is also simply
// the better behaviour.
//
// Three slices, because they have genuinely different owners in the database:
//
//   clients    — the client → location → floor → room tree, plus visits.
//   settings   — company details, logos and brand plate (team-wide, admin-only
//                to write) plus the signed-in member's own default technician.
//   templates  — the test lists, one per workflow kind (admin-only to write).
//
// The adapter is what varies:
//
//   local     — localStorage, exactly as the app has always worked. Used by the
//               headless suites and when no session exists.
//   supabase  — the real backend, once signed in.
//
// Both implement { load(), persist(next, previous) } over all three slices at
// once. `previous` is a snapshot taken at the last successful persist, which is
// what lets the Supabase adapter work out what actually changed rather than
// rewriting everything.
//
// Against a server, saving can fail and the app can be closed before it finishes
// (build plan 2.2), so the cache is also the save queue. Every change is written
// to a copy on the device first, then sent; what didn't reach the database stays
// out of the snapshot and is sent again when the connection returns and on a
// timer. A push reports what it managed rather than failing whole: a visit the
// database refuses goes on the `held` list and stops being sent, so it never
// holds up anything else.

import { isNetworkFailure } from './saveErrors.js'

const listeners = new Set()
// Set while a write made during a render runs: see put().
let quiet = false

const emptyState = () => ({
  clients: [],
  settings: null, // null means "not loaded"; the stores supply their own defaults
  templates: {},
})

const state = {
  data: emptyState(),
  adapter: null,
  snapshot: emptyState(), // what the backend is known to hold
  hydrated: false,
  status: 'idle', // 'idle' | 'loading' | 'saving' | 'saved' | 'offline' | 'error'
  error: null,

  device: null, // where unsaved work is kept (offlineStore.js); null for local
  held: {}, // visits the database refused, by id: see heldVisits()
  aliases: {}, // a visit started here → the open visit it joined
  problems: [], // what the last push couldn't save: { what, error }
  unsavedClients: [], // clients with something in that list
  others: [], // copies other tabs left behind, still to send

  revision: 0, // goes up on every change
  savedRevision: 0, // the revision the database has caught up with
  generation: 0, // goes up when the session changes, so late answers are ignored
  outside: 0, // goes up when a push changes the work: see outsideChanges()
}

// structuredClone rather than JSON round-tripping: the tree holds Dates and
// nested objects, and JSON silently turns a Date into a string.
const clone = v => structuredClone(v)

function emit() {
  if (quiet) return
  for (const fn of listeners) fn()
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const cacheStatus = () => ({
  status: state.status,
  error: state.error,
  hydrated: state.hydrated,
})

function setStatus(status, error = null) {
  state.status = status
  state.error = error
  emit()
}

export const hasAdapter = () => state.adapter !== null

/** 'local' | 'supabase' | null. Callers need this where the two genuinely
 *  differ — the localStorage quota warning has no meaning against Postgres. */
export const adapterName = () => state.adapter?.name ?? null

// ─────────────────────────────────────────────────────────────────────────────
// Reads — synchronous, which is the whole point of the layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a COPY, which is not incidental. The stores mutate their slice in
 * place and write it back, and callers hold pieces of it in React state. Hand
 * out the live object and a mutation is invisible to React: the reference is
 * unchanged, `Object.is` says nothing happened, and the component never
 * re-renders — the data saves correctly and the screen just does not move.
 *
 * The old implementations got this for free by parsing JSON on every read.
 * This keeps that contract, and is cheaper than the parse it replaces.
 */
/**
 * In local mode the store IS the source of truth, not a cache of it.
 *
 * localStorage can change under us — another tab, or a test seeding data
 * between navigations — and a hash route change does not remount the app, so a
 * value read once at boot would be served for the rest of the session. Since
 * reading it costs a JSON.parse and nothing more, local mode re-reads. That is
 * exactly what the app did before the cache existed.
 *
 * The Supabase adapter is the opposite: reading means a network round trip, so
 * its data is held and only refreshed deliberately.
 */
function current() {
  if (state.adapter?.live) {
    state.data = { ...emptyState(), ...(state.adapter.load() ?? {}) }
  }
  return state.data
}

// clone() is skipped in live mode because load() has just built these objects
// from JSON.parse — they are already nobody else's.
const take = name => (state.adapter?.live ? current()[name] : clone(state.data[name]))

export const readClients = () => take('clients')
export const readSettings = () => take('settings')
export const readTemplates = () => take('templates')

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

let timer = null
let retryTimer = null
let retryDelay = 0
let inFlight = null

const FIRST_RETRY = 30000
const LONGEST_RETRY = 5 * 60000
// Rounds of one push following another. Only someone typing through a slow push,
// or two devices merging back and forth, takes more than a few; past this it waits
// for the next change or the retry rather than hammering a poor connection.
const MOST_ROUNDS = 20

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false

// An adapter that talks to a server: unsaved work has to outlive this page, and
// saving can fail.
const durable = () => !!state.adapter && !state.adapter.immediate

function clearTimers() {
  clearTimeout(timer)
  clearTimeout(retryTimer)
  retryTimer = null
  retryDelay = 0
}

// Before anything is sent, so a closed app or a dead battery costs nothing. The
// copy holds what has to be sent and what the database is known to hold, which
// is enough to work the rest out again after a restart.
function keepOnDevice() {
  state.device?.save({
    data: state.data,
    snapshot: state.snapshot,
    held: state.held,
    unsaved: state.revision !== state.savedRevision || state.problems.length > 0,
    unsavedClients: state.unsavedClients,
  })
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  retryDelay = Math.min(retryDelay ? retryDelay * 2 : FIRST_RETRY, LONGEST_RETRY)
  retryTimer = setTimeout(flush, retryDelay)
}

function scheduleWrite() {
  if (!state.adapter) return

  // A synchronous adapter writes through immediately. Debouncing exists to
  // coalesce network round trips, and localStorage has none to coalesce —
  // delaying it only creates a window where the stored data disagrees with
  // memory, which is exactly what a caller reading straight back would hit.
  if (state.adapter.immediate) {
    try {
      state.adapter.persist(state.data, state.snapshot)
      state.snapshot = clone(state.data)
      setStatus('saved')
    } catch (e) {
      console.error('[cache] persist failed', e)
      setStatus('error', e)
    }
    return
  }

  clearTimeout(timer)
  // Nothing to try until the connection is back; the 'online' event picks it up.
  if (isOffline()) {
    setStatus('offline')
    return
  }
  setStatus('saving')
  timer = setTimeout(flush, 600)
}

// Refresh before applying, or a write to one slice persists whatever stale
// copy of the other two was in memory — silently reverting them.
//
// `duringRender` is for a write a component makes while it draws, as a template
// filled in on first read is. Telling the listeners then would update the header's
// save status in the middle of another component's render, which React warns about.
// The data is in memory at once, so every read sees the same ids; only the news
// waits until the render is over.
function put(name, next, { duringRender = false } = {}) {
  current()
  if (next !== undefined) state.data[name] = next
  state.revision += 1
  quiet = duringRender
  try {
    keepOnDevice()
    emit()
    scheduleWrite()
  } finally {
    quiet = false
  }
  if (duringRender) queueMicrotask(emit)
}

export const writeClients = next => put('clients', next)
export const writeSettings = next => put('settings', next)
export const writeTemplates = (next, options) => put('templates', next, options)

const pushWith = (adapter, next, previous, held) =>
  adapter.push ? adapter.push(next, previous, held) : adapter.persist(next, previous)

// What came back from a push. Only what reached the database moves into the
// snapshot, so whatever didn't is worked out again and sent next time. A refused
// visit goes on the held list, where it stops being sent at all.
function applyReport(report, pushing) {
  state.snapshot = report?.settled ?? pushing
  state.problems = report?.problems ?? []
  state.unsavedClients = report?.unsavedClients ?? []
  if (report?.held) state.held = { ...state.held, ...report.held }
  if (report?.aliases) Object.assign(state.aliases, report.aliases)
  // A visit joined or a room merged: the work on this device has changed under
  // whoever is looking at it, so an open room has to read it again.
  if (report?.rebase) {
    state.data = report.rebase(state.data)
    state.revision += 1
    state.outside += 1
  }
}

async function pushUntilCaughtUp() {
  const { adapter, generation } = state
  let rounds = 0
  try {
    do {
      if (isOffline()) {
        setStatus('offline')
        return false
      }
      rounds += 1
      if (rounds > MOST_ROUNDS) {
        scheduleRetry()
        return false
      }
      // Captured before awaiting: edits made during the push belong to the next
      // one, and treating them as already-saved would lose them.
      const revision = state.revision
      const pushing = clone(state.data)
      setStatus('saving')
      const report = await pushWith(adapter, pushing, state.snapshot, state.held)
      if (generation !== state.generation) return false
      state.savedRevision = revision
      applyReport(report, pushing)
      keepOnDevice()
    } while (state.revision !== state.savedRevision)
  } catch (e) {
    if (generation !== state.generation) return false
    console.error('[cache] save failed', e)
    setStatus(isNetworkFailure(e) ? 'offline' : 'error', e)
    keepOnDevice()
    scheduleRetry()
    return false
  }

  if (state.problems.length) {
    setStatus('error', state.problems[0].error)
    scheduleRetry()
    return false
  }
  clearTimeout(retryTimer)
  retryDelay = 0
  setStatus('saved')
  if (state.others.length) await pushOtherTabs(adapter, generation)
  return true
}

/**
 * Pushes pending changes now and resolves true when everything has landed, false
 * when something hasn't (it stays on the device and is tried again).
 *
 * Serialised through `inFlight`: two overlapping persists would diff against
 * the same snapshot and issue the same inserts twice. A flush arriving while one
 * runs just waits for it: the running one goes round again until it has caught up
 * with the latest edit, or that edit would sit unsent with the status saying "saved".
 */
export function flush() {
  clearTimeout(timer)
  if (!durable()) return Promise.resolve(true)
  if (inFlight) return inFlight
  const run = pushUntilCaughtUp().finally(() => {
    if (inFlight === run) inFlight = null
  })
  inFlight = run
  return run
}

// ─────────────────────────────────────────────────────────────────────────────
// Another tab's unsent work
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends what a stored copy still owes, going round again if a push changed it (a
 * visit joined). Answers whether the copy has nothing left to send, and hands
 * back any visit the database refused. Throws if the connection fails.
 */
export async function pushStoredCopy(adapter, copy) {
  let { data, snapshot } = copy
  let held = { ...(copy.held ?? {}) }
  let problems = 0
  for (let round = 0; round < 3; round++) {
    const pushing = clone(data)
    const report = await pushWith(adapter, pushing, snapshot, held)
    snapshot = report?.settled ?? pushing
    held = { ...held, ...(report?.held ?? {}) }
    problems = report?.problems?.length ?? 0
    if (!report?.rebase) break
    data = report.rebase(data)
  }
  return { clean: problems === 0, held, data }
}

function findVisitIn(data, id) {
  for (const client of data?.clients ?? []) {
    for (const location of client.locations ?? []) {
      const visit = (location.visits ?? []).find(v => v.id === id)
      if (visit) return visit
    }
  }
  return null
}

async function pushOtherTabs(adapter, generation) {
  const copies = state.others
  state.others = []
  for (const copy of copies) {
    if (!copy.unsaved && !Object.keys(copy.held ?? {}).length) {
      await state.device?.remove([copy.id])
      continue
    }
    try {
      const { clean, held, data } = await pushStoredCopy(adapter, copy)
      if (generation !== state.generation) return
      // A refused visit moves here, where it can be seen and dealt with.
      for (const [id, record] of Object.entries(held)) {
        state.held[id] = { ...record, visit: findVisitIn(data, id) ?? record.visit }
      }
      if (clean) await state.device?.remove([copy.id])
      else state.others.push(copy)
    } catch (e) {
      if (generation !== state.generation) return
      if (!isNetworkFailure(e)) console.error('[cache] could not save another tab', e)
      state.others.push(copy)
      return
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// What the app asks of the queue
// ─────────────────────────────────────────────────────────────────────────────

/** 'saving' | 'saved' | 'offline' | 'failed', or null when nothing is saved to a
 *  server at all. A string, so React can compare it (useSyncExternalStore). */
export function saveStatus() {
  if (adapterName() !== 'supabase') return null
  if (isOffline() || state.status === 'offline') return 'offline'
  if (state.status === 'error') return 'failed'
  if (state.status === 'saving' || state.status === 'loading') return 'saving'
  return 'saved'
}

export const saveError = () => state.error

export const heldCount = () => Object.keys(state.held).length

/** Visits the database refused, kept on this device: visit id → the reason, the
 *  client and site it belongs to, and whether its site still exists. */
export const heldVisits = () => clone(state.held)

/** A visit that joined another one still answers to its old id, for a page
 *  that opened it before the join happened. */
export const visitAlias = id => state.aliases[id] ?? id

/** Goes up when work on this device changed other than through the app's own
 *  writes, which is when an open room has to read it again. */
export const outsideChanges = () => state.outside

/** True while this device holds work the database hasn't got. */
export const hasUnsavedWork = () =>
  state.revision !== state.savedRevision ||
  state.problems.length > 0 ||
  Object.keys(state.held).length > 0

/** What the database is known to hold, for working out what a discard goes back to. */
export const readSaved = () => clone(state.snapshot.clients)

/** Takes visits back off the held list and sends them. No id means all of them,
 *  which is what an upgrade does (step B4). */
export function retryHeld(id) {
  if (id) delete state.held[id]
  else state.held = {}
  state.revision += 1
  keepOnDevice()
  emit()
  return flush()
}

/** Forgets a held visit for good. The caller takes it out of the tree. */
export function forgetHeld(id) {
  delete state.held[id]
  keepOnDevice()
  emit()
}

/**
 * A change the database already has, so it goes into both the working data and
 * the snapshot and nothing is left to send. How a visit the database has just
 * accepted joins the tree.
 */
export function commitSaved(change) {
  change(state.data.clients)
  change(state.snapshot.clients)
  keepOnDevice()
  emit()
}

const NO_ANSWER = Symbol('no answer')

function within(patience, work) {
  let timeout
  return Promise.race([
    work,
    new Promise(resolve => {
      timeout = setTimeout(() => resolve(NO_ANSWER), patience)
    }),
  ]).finally(() => clearTimeout(timeout))
}

/** A flush for someone standing there waiting: it carries on in the background
 *  after this stops waiting for it. */
export const flushWithin = patience => within(patience, flush())

/**
 * Asks the database to accept a visit, for as long as someone will reasonably
 * stand there waiting. After that it counts as offline: the visit opens and is
 * sent later, and if this attempt did land, its own id is what recognises it.
 */
export async function startOnServer(locationId, visit, patience = 10000) {
  if (!state.adapter?.startVisit || isOffline()) return { outcome: 'offline' }
  const answer = await within(patience, state.adapter.startVisit(locationId, visit))
  return answer === NO_ANSWER ? { outcome: 'offline' } : answer
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Same as hydrate() for an adapter whose load is synchronous — only the local
 * one. This is what lets the stores stay synchronous end to end in test and
 * offline mode: the very first read can fill the cache itself, with no bootstrap
 * step to forget and no window where the app renders against empty data.
 *
 * It refuses to run once an adapter is chosen, so it can never quietly replace
 * a signed-in user's Supabase data with whatever is in localStorage.
 */
export function hydrateSync(adapter) {
  if (state.adapter) return state.data
  state.adapter = adapter
  state.data = { ...emptyState(), ...(adapter.load() ?? {}) }
  state.snapshot = clone(state.data)
  state.hydrated = true
  return state.data
}

let watching = false

function watchConnection() {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('online', () => {
    if (!durable()) return
    retryDelay = 0
    flush()
  })
  window.addEventListener('offline', () => {
    if (durable()) setStatus('offline')
  })
}

function restore(copy) {
  state.data = { ...emptyState(), ...copy.data }
  state.snapshot = { ...emptyState(), ...copy.snapshot }
  state.held = copy.held ?? {}
  state.unsavedClients = copy.unsavedClients ?? []
  state.revision = copy.unsaved ? 1 : 0
  state.savedRevision = 0
  // Picked up from a tab that has gone: from here on it is this tab's.
  if (copy.id !== state.device.ownId) {
    keepOnDevice()
    state.device.remove([copy.id])
  }
}

/**
 * Loads the team's data. With a device copy to go on:
 *
 *   1. Restore it, so nothing depends on the network from here on.
 *   2. Send what it still owes, before reading anything: this device's edits go
 *      in as edits, rather than being overwritten by what it's about to read.
 *      Refused visits are tried again, which is how they save after an upgrade.
 *   3. Read the database, which is now the truth, and put back only what is
 *      still on this device alone.
 *
 * If the network is out, or too slow to wait for, the copy is what the app runs
 * on. What's unsent goes when the connection returns, and the next load brings in
 * other devices' changes.
 */
export async function hydrate(adapter, options = {}) {
  clearTimers()
  state.generation += 1
  const { generation } = state
  const stale = () => generation !== state.generation
  state.adapter = adapter
  if ('device' in options) state.device = options.device ?? null
  setStatus('loading')
  if (!adapter.immediate) watchConnection()

  let stored = null
  if (state.device) {
    try {
      stored = await state.device.load()
    } catch (e) {
      console.error('[cache] the device copy could not be read', e)
      state.device = null
    }
    if (stale()) return state.data
  }

  const own = stored?.own ?? null
  if (own) {
    restore(own)
    state.hydrated = true
  }
  state.others = stored?.others ?? []

  const heldBefore = state.held
  let gaveUp = false

  const work = async () => {
    if (isOffline()) throw { code: '', message: 'This device is offline' }

    if (own && (own.unsaved || Object.keys(heldBefore).length)) {
      state.held = {}
      await flush()
      if (stale()) return
      if (state.status === 'offline') throw state.error ?? { code: '', message: 'No connection' }
    } else if (state.others.length) {
      await pushOtherTabs(adapter, generation)
      if (stale()) return
    }

    const revisionBefore = state.revision
    const loaded = await adapter.load()
    if (stale()) return
    // Too late to wait for, but still worth having unless someone has started
    // working from the copy in the meantime. Their edits are safe either way: this
    // only decides whether they see other devices' changes now or on the next load.
    if (gaveUp && state.revision !== revisionBefore) return

    const local = state.data
    state.data = adapter.adopt
      ? adapter.adopt(loaded, local, state.held, state.unsavedClients)
      : { ...emptyState(), ...(loaded ?? {}) }
    state.snapshot = clone({ ...emptyState(), ...(loaded ?? {}) })
    state.hydrated = true
    state.revision = state.unsavedClients.length ? 1 : 0
    state.savedRevision = 0
    if (!state.unsavedClients.length) state.problems = []
    if (gaveUp) state.outside += 1
    keepOnDevice()
    if (state.problems.length) setStatus('error', state.problems[0].error)
    else setStatus('idle')
  }

  try {
    if (!own) {
      await work()
    } else {
      // The copy is good enough to work from, so a crawling connection doesn't
      // get to hold the technician at a spinner.
      let timeout
      const started = work()
      await Promise.race([
        started,
        new Promise(resolve => {
          timeout = setTimeout(() => {
            gaveUp = true
            resolve()
          }, options.patience ?? 8000)
        }),
      ])
      clearTimeout(timeout)
      // Still going: let it finish, and report a failure as a save would.
      if (gaveUp) {
        started.catch(e => {
          if (stale()) return
          if (isNetworkFailure(e)) setStatus('offline', e)
          else console.error('[cache] load failed', e)
        })
        if (state.status === 'loading') setStatus(options.expectOffline ? 'offline' : 'idle')
      }
    }
  } catch (e) {
    if (stale()) return state.data

    if (own && isNetworkFailure(e)) {
      if (!Object.keys(state.held).length) state.held = heldBefore
      setStatus('offline', e)
      keepOnDevice()
      scheduleRetry()
    } else {
      console.error('[cache] hydrate failed', e)
      state.data = emptyState()
      state.snapshot = emptyState()
      state.hydrated = false
      setStatus('error', e)
      throw e
    }
  }
  if (stale()) return state.data
  emit()
  return state.data
}

/** Stops all saving for this session, for signing out. Nothing more goes to the
 *  device or the database after this. */
export function closeSession() {
  clearTimers()
  state.generation += 1
  state.device = null
}

/** Drops everything held in memory — used on sign-out and account switches, so
 *  the next account cannot momentarily see the previous one's data. Unsent work
 *  is already on the device, under that account and team. */
export function resetCache() {
  clearTimers()
  state.generation += 1
  state.data = emptyState()
  state.snapshot = emptyState()
  state.hydrated = false
  state.adapter = null
  state.device = null
  state.status = 'idle'
  state.error = null
  state.held = {}
  state.aliases = {}
  state.problems = []
  state.unsavedClients = []
  state.others = []
  state.revision = 0
  state.savedRevision = 0
  inFlight = null
  emit()
}
