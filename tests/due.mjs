/**
 * Step C4: the Due page.
 *
 * The rules in Node first, then the page in a browser in test mode. Every
 * request off this machine is answered here, as due_list() would answer it, or
 * refused: nothing reaches the live project.
 *
 *   node tests/due.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - overdue first, then due in the next 60 days, then not done yet, then alarms
 *     expiring in the next 3 months, each named and dated in words
 *   - filtered by client
 *   - with no signal, the last list this device was given, saying when
 *   - no contact's email kept on the device; the list goes on signing out
 *   - a landlord's /due is untouched
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// ── The rules ───────────────────────────────────────────────────────────────
const { clientsIn, dueTitle, groupDue, whenText } = await import('../src/lib/due.js')

const row = (kind, extra = {}) => ({
  kind, dueOn: null, itemId: null, assetId: null, obligation: 'qld_smoke_alarm', label: '', lastDoneOn: null,
  remindersEnabled: true, clientId: 'c1', clientName: 'Rental Co', locationId: 'l1', address: '10 Smith St', suburb: 'Toowong', ...extra,
})
const ROWS = [
  row('expiring', { dueOn: '2026-12-01', assetId: 'a1', obligation: 'smoke_alarm', label: 'Hall alarm' }),
  row('not_done_yet', { obligation: 'maintenance', clientId: 'c2', clientName: 'Acme AV', itemId: null }),
  row('due', { dueOn: '2026-11-20', itemId: 'i2', lastDoneOn: '2025-11-20' }),
  row('overdue', { dueOn: '2026-10-03', itemId: 'i1', obligation: 'qld_electrical_safety', lastDoneOn: '2024-10-03' }),
]
const groups = groupDue(ROWS)
log('overdue first, then due, then not done yet, then alarms expiring',
  groups.map(g => g.kind).join() === 'overdue,due,not_done_yet,expiring', groups.map(g => g.kind).join())
log('a client filter keeps only that client\'s', groupDue(ROWS, 'c2').map(g => g.kind).join() === 'not_done_yet')
log('each client is offered once, by name', clientsIn([...ROWS, ROWS[0]]).map(c => c.name).join() === 'Acme AV,Rental Co')
log('a check is named as its page is, an alarm by its own name',
  dueTitle(ROWS[3]) === 'QLD electrical safety' && dueTitle(ROWS[0]) === 'Hall alarm' && dueTitle(row('expiring', { obligation: 'smoke_alarm' })) === 'Smoke alarm')
const today = '2026-11-04'
log('an overdue check says by how long', /^Was due .* · 32 days overdue$/.test(whenText(ROWS[3], today)), whenText(ROWS[3], today))
log('a due one says when', /^Due .* · in 16 days$/.test(whenText(ROWS[2], today)) && /tomorrow$/.test(whenText(row('due', { dueOn: '2026-11-05' }), today)))
log('a site not done yet says so', whenText(ROWS[1], today) === 'No visit yet')
log('an alarm says when it expires, or that it has',
  /^Expires .* · in 27 days$/.test(whenText(ROWS[0], today)) && /^Expired /.test(whenText(row('expiring', { dueOn: '2026-11-01' }), today)))

// ── The page ────────────────────────────────────────────────────────────────
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const localhost = new URL(BASE).hostname
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const db = { calls: [], down: false }
// due_list() as the database answers it, with the contacts it carries for the
// reminder email.
const answer = [
  { kind: 'overdue', due_on: '2026-10-03', item_id: 'i1', asset_id: null, obligation: 'qld_electrical_safety', label: 'Electrical safety check', last_done_on: '2024-10-03', reminders_enabled: true, client_id: 'c1', client_name: 'Rental Co', contact_name: 'Jane', contact_email: 'jane@example.com', location_id: 'l1', address: '10 Smith St', suburb: 'Toowong' },
  { kind: 'due', due_on: '2026-12-20', item_id: 'i2', asset_id: null, obligation: 'qld_smoke_alarm', label: 'Smoke alarm compliance inspection', last_done_on: '2025-12-20', reminders_enabled: true, client_id: 'c1', client_name: 'Rental Co', contact_name: 'Jane', contact_email: 'jane@example.com', location_id: 'l1', address: '10 Smith St', suburb: 'Toowong' },
  { kind: 'not_done_yet', due_on: null, item_id: null, asset_id: null, obligation: 'maintenance', label: 'Preventative maintenance', last_done_on: null, reminders_enabled: true, client_id: 'c2', client_name: 'Acme AV', contact_name: '', contact_email: 'ops@acme.example', location_id: 'l2', address: '1 Pitt St', suburb: 'Sydney' },
  { kind: 'expiring', due_on: '2027-01-15', item_id: null, asset_id: 'a1', obligation: 'smoke_alarm', label: 'Hall alarm', last_done_on: null, reminders_enabled: null, client_id: 'c1', client_name: 'Rental Co', contact_name: 'Jane', contact_email: 'jane@example.com', location_id: 'l1', address: '10 Smith St', suburb: 'Toowong' },
]
async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  // Answers the test gives itself get through with the browser offline, so a
  // dropped connection is played here.
  if (db.down) return route.abort('internetdisconnected')
  if (url.pathname === '/rest/v1/rpc/due_list') {
    db.calls.push(JSON.parse(req.postData()))
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(answer) })
  }
  return route.abort()
}

const ENTITLEMENTS = {
  enforced: false, accountType: 'provider', plan: 'pro', isPro: true, seatLimit: 1, seatsUsed: 1,
  visitLimit: null, visitsUsed: 0, packs: ['core', 'av', 'qld_electrical'], pastDueUntil: null,
  cancelAt: null, importUsed: false, openVisits: 0, starterPack: 'qld_electrical', starterInUse: true,
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  await ctx.route('**/*', backend)
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  const main = () => page.textContent('main')
  const holds = entitlements =>
    page.evaluate(async e => {
      const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
      const mod = await import(url ?? '/src/lib/entitlements.js')
      await mod.openEntitlements('team', 'user', { getEntitlements: async () => e })
    }, entitlements)
  const open = async () => {
    await page.goto(BASE + '#/checks-due', { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  log('an inspecting team has Due in its sidebar', (await page.getByRole('link', { name: 'Due', exact: true }).count()) === 1)
  await open()
  log('with no team, it says the list needs one', /Sign in to a team to see it/.test(await main()) && db.calls.length === 0)

  await holds(ENTITLEMENTS)
  await page.getByRole('region', { name: 'Overdue' }).waitFor()
  const order = await page.locator('main section').evaluateAll(s => s.map(x => x.getAttribute('aria-label')))
  log('the list comes in its order', order.join(' | ') === 'Overdue | Due in the next 60 days | Not done yet | Alarms expiring in the next 3 months', order.join(' | '))
  log('asked of due_list() for this team, 60 days and 3 months ahead',
    JSON.stringify(db.calls.at(-1)) === '{"p_team_id":"team","p_within_days":60,"p_expiry_months":3}', JSON.stringify(db.calls.at(-1)))
  const overdue = await page.getByRole('region', { name: 'Overdue' }).textContent()
  log('each check named as its page is, with its client, site and dates',
    /QLD electrical safety/.test(overdue) && /Rental Co · 10 Smith St, Toowong/.test(overdue) && /days overdue/.test(overdue) && /Last done /.test(overdue), overdue)
  log('a site not done yet, and an alarm by its own name',
    /Preventative Maintenance[\s\S]*Acme AV[\s\S]*No visit yet/.test(await page.getByRole('region', { name: 'Not done yet' }).textContent()) &&
      /Hall alarm[\s\S]*Expires /.test(await page.getByRole('region', { name: 'Alarms expiring in the next 3 months' }).textContent()))
  await page.screenshot({ path: `${DIR}/due-page.png`, fullPage: true })

  await page.getByLabel('Client').selectOption({ label: 'Acme AV' })
  log('filtered by client, only theirs is left',
    (await page.locator('main section').count()) === 1 && /Acme AV/.test(await main()) && !/Rental Co ·/.test(await main()))
  await page.getByLabel('Client').selectOption({ label: 'All clients' })

  const kept = await page.evaluate(() => localStorage.getItem('fc.session.due'))
  log('the device keeps the list, without the contacts\' emails', /Hall alarm/.test(kept ?? '') && !/@/.test(kept ?? ''), kept?.slice(0, 120))

  // No signal: the last list, dated.
  await ctx.setOffline(true)
  db.down = true
  await page.evaluate(async () => {
    // A fresh read with the connection gone, as opening the page later would.
    location.hash = '#/'
  })
  await page.getByRole('link', { name: 'Due', exact: true }).click()
  await page.getByRole('region', { name: 'Overdue' }).waitFor()
  log('with no signal it shows the last list, saying when it was', /No connection\. This is the list as it was /.test(await main()), (await main()).slice(0, 200))
  await ctx.setOffline(false)
  db.down = false

  // Signing out takes it with it.
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/prefs.js')).pop()
    const { prefs } = await import(url ?? '/src/lib/prefs.js')
    prefs.clearLastDue()
  })
  log('clearing it leaves nothing behind', (await page.evaluate(() => localStorage.getItem('fc.session.due'))) === null)

  // A landlord's /due is theirs.
  await page.goto(BASE + '#/due', { waitUntil: 'networkidle' })
  await holds({ ...ENTITLEMENTS, accountType: 'landlord', packs: ['core'], starterPack: null })
  log('a landlord\'s Due is their own page, not this one', !/Overdue|Sign in to a team to see it/.test(await main()) && (await page.getByRole('link', { name: 'Due', exact: true }).count()) === 1)
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
