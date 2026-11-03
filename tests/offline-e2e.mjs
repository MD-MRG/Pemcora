// Offline and multiple devices against the real project (build plan B3).
//
//   node tests/offline-e2e.mjs <email> <password>
//
// tests/offline.mjs proves the app's behaviour against a stand-in for the database.
// This proves the stand-in told the truth: real Postgres answering, the real
// triggers, the real Supabase client, two real browser sessions on one account,
// real device storage. It checks the rows from outside the browser.
//
// WRITES TO THE LIVE PROJECT, so nothing runs it automatically. It needs the dev
// server on 5173 and a confirmed account. It makes a team of its own, deletes that
// team at the end along with everything under it, and touches nothing else.
//
// The plan limits are off until step E6, so the real database doesn't refuse on
// plan today. For that one case, the refusal is answered here with what the database
// would send (HTTP 402, hint 'upgrade').

import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { createClient } from '@supabase/supabase-js'
import { classifySaveError } from '../src/lib/saveErrors.js'

const BASE = 'http://localhost:5173/'
const [EMAIL, PASSWORD] = process.argv.slice(2)
if (!EMAIL || !PASSWORD) {
  console.error('Usage: node tests/offline-e2e.mjs <email> <password>  (a confirmed account)')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

let failures = 0
const log = (ok, name, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(150)
  }
  return false
}

// A second, independent view of the data — the browser's own client could be
// serving the cache, so verification has to come from outside it.
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})
const signedIn = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (signedIn.error) {
  console.error(`FAIL  could not sign in: ${signedIn.error.message}`)
  process.exit(1)
}

// A run that crashed outright can leave its team behind. Clear those first: only teams
// of this suite's name, that this account owns.
{
  const { data: mine } = await sb.rpc('my_teams')
  for (const left of (mine ?? []).filter(t => t.role === 'owner' && /^Offline test \d+$/.test(t.name))) {
    const { error } = await sb.from('teams').delete().eq('id', left.team_id)
    console.log(error ? `Could not delete ${left.name} left by an earlier run: ${error.message}` : `Deleted ${left.name}, left by an earlier run`)
  }
}

// A failure inside a request handler isn't the main flow's to catch, and would end the
// run without deleting its team. Count it, and let the run carry on to its clean-up.
process.on('unhandledRejection', e => log(false, 'a request handler threw', e?.message))

const stamp = Date.now()
const { data: team, error: teamError } = await sb.rpc('create_team', { p_name: `Offline test ${stamp}` })
if (teamError) {
  console.error(`FAIL  could not make a test team: ${teamError.message}`)
  process.exit(1)
}

const uuid = () => crypto.randomUUID()
const ids = { client: uuid(), location: uuid(), floor: uuid(), r1: uuid(), r2: uuid() }
await sb.from('clients').insert({ id: ids.client, team_id: team.id, name: 'Offline Test Client' })
await sb.from('locations').insert({
  id: ids.location, team_id: team.id, client_id: ids.client, address: '8 Grand Avenue', suburb: 'Rosehill',
})
await sb.from('floors').insert({ id: ids.floor, team_id: team.id, location_id: ids.location, label: 'Ground', position: 0 })
await sb.from('rooms').insert([
  { id: ids.r1, team_id: team.id, floor_id: ids.floor, name: 'Room r1', position: 0 },
  { id: ids.r2, team_id: team.id, floor_id: ids.floor, name: 'Room r2', position: 1 },
])

const browser = await launch()

async function signIn() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(id => localStorage.setItem('fc.team.active', JSON.stringify(id)), team.id)
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.locator('nav a').nth(6).waitFor({ timeout: 20000 })
  return { ctx, page }
}

async function goToSite(page) {
  await page.locator('nav a').filter({ hasText: 'Settings' }).click()
  await page.locator('nav a').filter({ hasText: 'Preventative Maintenance' }).click()
  await page.locator('tbody tr').filter({ hasText: 'Offline Test Client' }).click()
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
}

const start = page => page.getByRole('button', { name: /^(Start PM|Start new visit)$/ }).click()
const openRoom = (page, name) => page.getByRole('button', { name: new RegExp(`^Room ${name}`) }).click()
const resultButton = (page, test, value) => page.getByRole('button', { name: `${test}: ${value}`, exact: true })
const answer = (page, test, value) => resultButton(page, test, value).click()
const isPressed = async (page, test, value) =>
  (await resultButton(page, test, value).getAttribute('aria-pressed')) === 'true'
const status = async page => {
  const el = page.locator('div.text-right[role="status"]')
  return (await el.count()) ? (await el.textContent()).trim() : ''
}
const statusIs = (page, pattern) => until(async () => pattern.test(await status(page)))
const mainText = page => page.textContent('main')

const visitRows = async () =>
  (await sb.from('visits').select('*, visit_rooms(*)').eq('team_id', team.id).order('started_at')).data ?? []
const openRow = async () => (await visitRows()).find(v => !v.completed_at)
const onDatabase = async (test, roomId = ids.r1) => {
  const row = (await openRow())?.visit_rooms?.find(r => r.room_id === roomId)
  const t = row?.template?.tests?.find(x => x.label === test)
  return t ? row.results?.main?.[t.id] : undefined
}
const used = async () =>
  (await sb.from('team_usage').select('visits_started').eq('team_id', team.id)).data?.reduce((n, r) => n + r.visits_started, 0) ?? 0

const FIRST = 'Correct Time and Date'
const SECOND = 'Room Wake On Touch'
const THIRD = 'Test call performed'
const FOURTH = 'Video quality'

let a, b
try {
  a = await signIn()
  b = await signIn()
  await goToSite(a.page)
  await goToSite(b.page)

  // ── What the team has (step B4) ───────────────────────────────────────────
  const seen = await a.page.evaluate(async id => (await import('/src/lib/api.js')).getEntitlements(id), team.id)
  log(seen?.accountType === 'provider' && seen.packs.includes('core') && seen.packs.includes('av'),
    'the real team_entitlements() reaches the app, and a team made today holds AV', JSON.stringify(seen))
  log(seen?.enforced === false, 'with the limits still off')
  log(typeof seen?.visitsUsed === 'number' && typeof seen?.seatsUsed === 'number' && typeof seen?.isPro === 'boolean',
    'in the shape the app expects')

  // ── Starting online, on two devices ──────────────────────────────────────
  await start(a.page)
  log(await until(async () => !!(await openRow())), 'the visit reaches the database')
  log(await statusIs(a.page, /^Saved$/), 'the header says Saved', await status(a.page))

  await start(b.page)
  log(await until(async () => /already started this visit/.test(await mainText(b.page))), 'the second device is told it joined')
  log((await visitRows()).length === 1, 'one visit, not two', `${(await visitRows()).length}`)
  log((await used()) === 1, 'counted once', `${await used()}`)

  // ── The same room on both ─────────────────────────────────────────────────
  await openRoom(a.page, 'r1')
  await openRoom(b.page, 'r1')
  await answer(a.page, FIRST, 'PASS')
  log(await until(async () => (await onDatabase(FIRST)) === 'PASS'), 'an answer reaches the database')
  await answer(b.page, SECOND, 'FAIL')
  log(await until(async () => (await onDatabase(SECOND)) === 'FAIL' && (await onDatabase(FIRST)) === 'PASS'),
    'answers from both devices end up in one room')
  log(await until(() => isPressed(b.page, FIRST, 'PASS')), 'the second device shows the first one\'s answer')
  await answer(a.page, THIRD, 'PASS')
  log(await until(async () => (await onDatabase(THIRD)) === 'PASS' && (await onDatabase(SECOND)) === 'FAIL'),
    'the first device\'s next save keeps the second one\'s answer')

  // ── A dropped connection ──────────────────────────────────────────────────
  await a.ctx.setOffline(true)
  log(await statusIs(a.page, /^Offline: changes are kept on this device$/), 'losing the connection shows at once', await status(a.page))
  await answer(a.page, FOURTH, 'FAIL')
  // By its test: the room already has another FAIL with a note box of its own.
  await a.page.getByRole('textbox', { name: FOURTH, exact: true }).fill('Noted offline')
  await a.page.locator('h1').click()
  await sleep(1200)
  log((await onDatabase(FOURTH)) === undefined, 'nothing reached the database while offline')
  await a.ctx.setOffline(false)
  log(await until(async () => (await onDatabase(FOURTH)) === 'FAIL'), 'when it returns, the answer goes by itself')
  const noted = (await openRow()).visit_rooms.find(r => r.room_id === ids.r1)
  log(Object.values(noted.troubleshooting).includes('Noted offline'), 'with its note')
  log(await statusIs(a.page, /^Saved$/), 'and the header says Saved', await status(a.page))

  // ── A reload with unsaved changes ─────────────────────────────────────────
  // The page itself can reload; only saves are cut off.
  await a.ctx.route('**/rest/v1/visit_rooms*', route =>
    route.request().method() === 'GET' ? route.continue() : route.abort(),
  )
  await answer(a.page, FOURTH, 'PASS')
  // It had a FAIL with a note, and the app asks before throwing the note away.
  await a.page.getByRole('dialog').getByRole('button', { name: 'Discard notes' }).click()
  log(await statusIs(a.page, /^Offline/), 'a save that can\'t get through says so', await status(a.page))
  await a.page.reload({ waitUntil: 'networkidle' })
  await goToSite(a.page)
  await openRoom(a.page, 'r1')
  log(await isPressed(a.page, FOURTH, 'PASS'), 'after a reload the unsaved answer is back')
  await a.ctx.unroute('**/rest/v1/visit_rooms*')
  await a.page.evaluate(() => window.dispatchEvent(new Event('online')))
  log(await until(async () => (await onDatabase(FOURTH)) === 'PASS'), 'and it goes when saving works again')

  // ── Closing the tab straight after an edit ───────────────────────────────
  await a.ctx.route('**/rest/v1/visit_rooms*', route =>
    route.request().method() === 'GET' ? route.continue() : route.abort(),
  )
  await answer(a.page, FIRST, 'N/A') // the button's label; the database keeps NA
  await a.page.close()
  await a.ctx.unroute('**/rest/v1/visit_rooms*')
  a.page = await a.ctx.newPage()
  await a.page.goto(BASE, { waitUntil: 'networkidle' })
  log(await until(async () => (await onDatabase(FIRST)) === 'NA'), 'an edit followed at once by closing the tab still arrives')
  await a.page.locator('nav a').nth(6).waitFor({ timeout: 20000 })

  // ── A visit continued the next day ───────────────────────────────────────
  await goToSite(a.page)
  log((await a.page.getByRole('button', { name: /^Continue$/ }).count()) === 1, 'on a fresh load the visit is still open')
  log((await used()) === 1, 'and still counted once', `${await used()}`)

  // Finish it, on both, ready for the next part.
  await a.page.getByRole('button', { name: /^Finish visit$/ }).click()
  await a.page.getByRole('dialog').getByRole('button', { name: /finish/i }).click()
  log(await until(async () => !(await openRow())), 'finishing it reaches the database')

  // ── An answer lost on the way back ───────────────────────────────────────
  // The insert lands, and the device never hears. Sent again, real Postgres answers
  // 23505, and the visit's own id is what says "that was you".
  // Only the first insert loses its answer. The device sends it again by itself, and
  // that one may arrive while this is being taken away.
  let lost = false
  await a.ctx.route('**/rest/v1/visits?*', async route => {
    if (route.request().method() !== 'POST' || lost) return route.continue().catch(() => {})
    lost = true
    await route.fetch()
    return route.abort().catch(() => {})
  })
  await start(a.page)
  log(await until(async () => !!(await openRow())), 'an insert whose answer is lost still landed')
  await sleep(500)
  await a.ctx.unroute('**/rest/v1/visits?*')
  await a.page.evaluate(() => window.dispatchEvent(new Event('online')))
  log(await statusIs(a.page, /^Saved$/), 'sent again, it recognises itself and carries on', await status(a.page))
  log((await visitRows()).filter(v => !v.completed_at).length === 1, 'no second visit')
  log((await used()) === 2, 'counted once more, not twice', `${await used()}`)

  // Back to no open visit.
  await a.page.getByRole('button', { name: /^Finish visit$/ }).click()
  await a.page.getByRole('dialog').getByRole('button', { name: /finish/i }).click()
  await until(async () => !(await openRow()))

  // ── Deleting a report record ─────────────────────────────────────────────
  const exportsOf = async () =>
    (await sb.from('visit_exports').select('revision').eq('team_id', team.id)).data ?? []
  const exportsBefore = (await exportsOf()).length
  const saved = a.page.waitForEvent('download', { timeout: 30000 })
  await a.page.getByRole('button', { name: 'Export report' }).click()
  await saved
  log(await until(async () => (await exportsOf()).length === exportsBefore + 1), 'an exported report is recorded on the database')
  await a.page.getByRole('button', { name: 'Delete revision 1' }).click()
  await a.page.getByRole('button', { name: 'Delete record' }).click()
  log(await until(async () => (await exportsOf()).length === exportsBefore), 'deleting the record deletes it on the database')
  await a.page.reload({ waitUntil: 'networkidle' })
  await goToSite(a.page)
  log((await a.page.getByRole('button', { name: 'Delete revision 1' }).count()) === 0, 'and it stays deleted after a reload')

  // ── A refused start ───────────────────────────────────────────────────────
  const refuse = route =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 402,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'PT402', message: 'This plan includes 1 inspection a month, and this month\'s has been used', hint: 'upgrade', details: null }),
        })
      : route.continue()

  await a.ctx.route('**/rest/v1/visits?*', refuse)
  await start(a.page)
  log(await until(async () => /free inspection/.test(await a.page.getByRole('dialog').textContent().catch(() => ''))), 'refused online: the upgrade sheet says why')
  await a.page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click()
  log((await a.page.getByRole('button', { name: /^Start new visit$/ }).count()) === 1, 'and nothing opened')

  await a.ctx.setOffline(true)
  await start(a.page)
  log(await until(async () => /Started on this device/.test(await mainText(a.page))), 'offline, it opens anyway')
  await a.ctx.setOffline(false)
  log(await until(async () => /Not saved:/.test(await mainText(a.page))), 'refused on reconnecting, it is marked Not saved')
  log(await statusIs(a.page, /1 visit not saved/), 'and the header counts it', await status(a.page))
  await a.ctx.unroute('**/rest/v1/visits?*')
  const before = await used()
  await a.page.getByRole('button', { name: 'Try again' }).click()
  log(await until(async () => !!(await openRow())), 'after an upgrade, it saves')
  log(await until(async () => !/Not saved:/.test(await mainText(a.page))), 'and the mark goes')
  log((await used()) === before + 1, 'the refusals used nothing', `${before} → ${await used()}`)

  // ── The same visit started offline, with the other device online ─────────
  await a.page.getByRole('button', { name: /^Finish visit$/ }).click()
  await a.page.getByRole('dialog').getByRole('button', { name: /finish/i }).click()
  await until(async () => !(await openRow()))
  await b.page.reload({ waitUntil: 'networkidle' })
  await goToSite(b.page)

  await a.ctx.setOffline(true)
  await start(a.page)
  await until(async () => /Started on this device/.test(await mainText(a.page)))
  await openRoom(a.page, 'r2')
  await answer(a.page, FIRST, 'FAIL')
  await sleep(300)

  await start(b.page)
  await until(async () => !!(await openRow()))
  const theirs = (await openRow()).id
  await openRoom(b.page, 'r2')
  await answer(b.page, SECOND, 'PASS')
  await until(async () => (await onDatabase(SECOND, ids.r2)) === 'PASS')

  const countBefore = await used()
  await a.ctx.setOffline(false)
  log(await until(async () => (await onDatabase(FIRST, ids.r2)) === 'FAIL'), 'coming back online joins the open visit')
  log((await openRow()).id === theirs && (await onDatabase(SECOND, ids.r2)) === 'PASS', 'with both devices\' answers, under the one visit')
  log((await used()) === countBefore, 'and nothing more is counted', `${countBefore} → ${await used()}`)
  log(await until(() => isPressed(a.page, SECOND, 'PASS')), 'the open room catches up on screen')
  await answer(a.page, THIRD, 'PASS')
  log(await until(async () => (await onDatabase(THIRD, ids.r2)) === 'PASS'), 'and carries on saving')

  // ── A room deleted on another device ─────────────────────────────────────
  await a.ctx.route('**/rest/v1/visit_rooms*', route =>
    route.request().method() === 'GET' ? route.continue() : route.abort(),
  )
  await answer(a.page, FOURTH, 'PASS')
  await statusIs(a.page, /^Offline/)
  await sb.from('rooms').delete().eq('id', ids.r2)
  await a.ctx.unroute('**/rest/v1/visit_rooms*')
  await a.page.evaluate(() => window.dispatchEvent(new Event('online')))
  const kept = async () =>
    (await openRow())?.visit_rooms?.filter(r => !r.room_id).some(r => Object.values(r.results?.main ?? {}).includes('PASS'))
  log(await until(kept), 'its answers are kept against no room, by the real foreign key')
  log(await statusIs(a.page, /^Saved$/), 'and saving carries on', await status(a.page))

  // ── How the real database refuses things ─────────────────────────────────
  const insert = row => sb.from('visits').insert({ team_id: team.id, location_id: ids.location, kind: 'maintenance', ...row })
  const old = await insert({ kind: 'commissioning', started_at: new Date(Date.now() - 8 * 86400000).toISOString() })
  log(classifySaveError(old.error) === 'date', 'a date more than 7 days back is classed as a date refusal', `${old.error?.code} ${old.error?.hint}`)
  const dupe = await insert({})
  log(classifySaveError(dupe.error) === 'conflict', 'a second open visit is classed as a conflict', dupe.error?.code)
  // The security rules answer before the foreign key: a missing parent comes back as
  // "not allowed", which is why api.js looks for it.
  const orphan = await sb.from('visit_rooms').insert({ team_id: team.id, visit_id: uuid(), room_id: ids.r1 })
  log(orphan.error?.code === '42501', 'the real database refuses a room under a missing visit as not allowed', orphan.error?.code)
  const throughApp = await b.page.evaluate(
    async ({ teamId, visitId }) => {
      const api = await import('/src/lib/api.js')
      try {
        await api.saveRoomlessVisitRoom(teamId, visitId, { roomName: 'Room r1', results: { main: {} } })
        return null
      } catch (e) {
        return { code: e.code, hint: e.hint }
      }
    },
    { teamId: team.id, visitId: uuid() },
  )
  log(classifySaveError(throughApp) === 'gone', 'and through the app it is classed as gone', JSON.stringify(throughApp))

  // ── A correction open elsewhere ──────────────────────────────────────────
  const openNow = await openRow()
  await sb.from('visits').update({ completed_at: new Date().toISOString() }).eq('id', openNow.id)
  await a.page.reload({ waitUntil: 'networkidle' })
  await goToSite(a.page)
  await a.ctx.setOffline(true)
  await start(a.page)
  await until(async () => /Started on this device/.test(await mainText(a.page)))
  await sb.from('visits').update({ completed_at: null }).eq('id', openNow.id) // reopened elsewhere
  await a.ctx.setOffline(false)
  log(await until(async () => /correction to an earlier visit/.test(await mainText(a.page))), 'a correction open elsewhere is not joined, and says why')
  log((await visitRows()).filter(v => !v.completed_at).length === 1, 'nothing new reached the database')
  await sb.from('visits').update({ completed_at: new Date().toISOString() }).eq('id', openNow.id)
  await a.page.getByRole('button', { name: 'Try again' }).click()
  log(await until(async () => !/Not saved:/.test(await mainText(a.page))), 'with the correction finished, the new visit saves')

  // ── Readings, the whole-site step and room types (C1) ────────────────────
  // Through each device's own store and save queue, on the real database.
  await b.page.reload({ waitUntil: 'networkidle' })
  await goToSite(b.page)
  await until(async () => !!(await openRow()))
  const where = { clientId: ids.client, locationId: ids.location, visitId: (await openRow()).id, roomId: ids.r1 }
  const SITE_LIST = {
    mainLabel: 'Main test list',
    tests: [],
    sections: [
      { id: 'ss', label: 'Whole property', scope: 'site', tests: [{ id: 'w1', label: 'Alarm on each level' }] },
      { id: 'si', label: 'Each smoke alarm', scope: 'item', assetType: 'smoke_alarm', tests: [{ id: 'k1', label: 'Works' }] },
    ],
  }
  const saveSite = (page, results) =>
    page.evaluate(
      async ({ where, results, template }) => {
        const store = await import('/src/lib/clientStore.js')
        const cache = await import('/src/lib/cache.js')
        const site = store.getSiteEntry(where.clientId, where.locationId, where.visitId)
        store.saveSiteEntry(where.clientId, where.locationId, where.visitId, {
          template,
          results: { ...(site?.results ?? {}), ...results },
        })
        return cache.flush()
      },
      { where, results, template: SITE_LIST },
    )
  const siteNow = async () => (await openRow())?.site_results ?? {}

  await saveSite(a.page, { ss: { w1: 'PASS' } })
  log((await siteNow()).results?.ss?.w1 === 'PASS', 'a whole-site answer reaches the real database')
  // The second device read the visit before that answer, and adds one of its own.
  await saveSite(b.page, { si: { alarm1: { k1: 'FAIL' } } })
  const both = await siteNow()
  log(both.results?.ss?.w1 === 'PASS' && both.results?.si?.alarm1?.k1 === 'FAIL',
    'one from each device ends up in one whole-site step', JSON.stringify(both.results))
  log(await until(() => b.page.evaluate(async w => {
    const store = await import('/src/lib/clientStore.js')
    return store.getSiteEntry(w.clientId, w.locationId, w.visitId)?.results?.ss?.w1 === 'PASS'
  }, where)), 'and the second device holds the first one\'s answer')

  await a.page.evaluate(async w => {
    const store = await import('/src/lib/clientStore.js')
    const cache = await import('/src/lib/cache.js')
    store.saveRoomEntry(w.clientId, w.locationId, w.visitId, w.roomId, {
      results: { main: {} },
      readings: { main: { insulation: { value: '0.4', unit: 'MΩ' } } },
    })
    return cache.flush()
  }, where)
  const reading = (await openRow())?.visit_rooms?.find(x => x.room_id === ids.r1)?.readings?.main?.insulation
  log(reading?.value === '0.4' && reading?.unit === 'MΩ', 'a room\'s reading reaches the real database', JSON.stringify(reading))

  const typed = await a.page.evaluate(async id => {
    const api = await import('/src/lib/api.js')
    try {
      await api.updateRoom(id, { roomType: 'bedroom' })
      return null
    } catch (e) {
      return e.message
    }
  }, ids.r1)
  const typeRow = (await sb.from('rooms').select('room_type').eq('id', ids.r1).single()).data
  log(!typed && typeRow?.room_type === 'bedroom', 'a room\'s type is saved', typed ?? typeRow?.room_type)

  // Finished, reopened for a correction, finished again: the first date stands.
  const finishOn = page => page.evaluate(async w => {
    const store = await import('/src/lib/clientStore.js')
    const cache = await import('/src/lib/cache.js')
    store.completeVisit(w.clientId, w.locationId, w.visitId)
    return cache.flush()
  }, where)
  await finishOn(a.page)
  const firstDate = (await visitRows()).find(v => v.id === where.visitId)?.completed_at
  log(!!firstDate, 'finishing it reaches the database')
  await sleep(1500)
  await sb.from('visits').update({ completed_at: null }).eq('id', where.visitId) // reopened elsewhere
  const answered = await a.page.evaluate(async id => {
    const api = await import('/src/lib/api.js')
    return api.updateVisit(id, { completedAt: new Date().toISOString() })
  }, where.visitId)
  log(Date.parse(answered?.completedAt) === Date.parse(firstDate),
    'finished again, the real database hands back the date it kept', answered?.completedAt + ' vs ' + firstDate)
  await a.page.reload({ waitUntil: 'networkidle' })
  await goToSite(a.page)
  const shown = await a.page.evaluate(d => new Date(d).toLocaleDateString(), firstDate)
  log(await until(async () => (await mainText(a.page)).includes('Last visit completed ' + shown)),
    'and the site page shows that date')

  // ── Signing out ───────────────────────────────────────────────────────────
  await a.page.locator('nav a').filter({ hasText: 'Settings' }).click()
  await a.page.getByRole('button', { name: 'Sign out' }).click()
  await a.page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click()
  log(await until(async () => (await a.page.getByRole('heading', { name: /sign in/i }).count()) === 1), 'signing out works')
  const left = await a.page.evaluate(
    () =>
      new Promise(resolve => {
        const open = indexedDB.open('pemcora-offline')
        open.onsuccess = () => {
          const all = open.result.transaction('copies').objectStore('copies').getAll()
          all.onsuccess = () => resolve(all.result.length)
        }
      }),
  )
  log(left === 0, 'with nothing unsaved, it leaves no copy on the device', `${left}`)
  // This suite's own login is another device's. Renewing it asks the real Auth server
  // whether that login is still alive.
  const renewed = await sb.auth.refreshSession()
  log(!renewed.error && !!renewed.data.session, 'and the same account stays signed in on its other devices', renewed.error?.message)
} catch (e) {
  log(false, 'suite threw before finishing', e.message)
} finally {
  await browser.close()
  const removed = await sb.from('teams').delete().eq('id', team.id)
  if (removed.error) console.error(`Could not delete the test team ${team.id}: ${removed.error.message}`)
  console.log(`\n${failures === 0 ? 'All assertions passed.' : `${failures} assertion(s) FAILED.`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}
