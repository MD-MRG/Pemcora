/**
 * Steps C3, C3b and C3c: licence numbers, reminders and how often checks are
 * due, in Settings and on a client.
 *
 * The interval rules in Node first, then a browser in test mode. A team's packs
 * are put in place as the app reads them, so an AV team and one doing electrical
 * checks can both be looked at. Every request off this machine is answered here,
 * as the database would answer it, or refused: nothing reaches the live project.
 *
 *   node tests/client-settings.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - a team whose checks are signed off records the company's licence and REC
 *     numbers, which print on its reports, and each technician's own licence
 *     number, which fills in the sign-off
 *   - an AV team's Settings don't ask for licence numbers
 *   - re-check reminders can be switched off for the whole team, and for one client
 *   - a client's contact is kept with it, and an address that isn't an email says so
 *   - how often a recurring check is due can be set for the team and for one
 *     client, never for one the law fixes; it needs a connection
 */
import { chromium } from 'playwright-core'
import ExcelJS from 'exceljs'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const SEED = [
  {
    id: 'c1',
    name: 'Rental Co',
    locations: [
      {
        id: 'l1',
        address: '10 Smith St',
        suburb: 'Toowong',
        city: 'Brisbane',
        state: 'QLD',
        postcode: '4066',
        floors: [{ id: 'f1', label: 'Upstairs', rooms: [{ id: 'b1', name: 'Bedroom 1', planNumber: '', roomType: 'bedroom' }] }],
        visits: [],
      },
    ],
  },
]

// ── The interval rules ──────────────────────────────────────────────────────
const { everyText, fallbackText, readMonths, recurringWorkflows } = await import('../src/lib/intervals.js')
const { workflow } = await import('../src/data/packs/index.js')
log('an AV team\'s recurring check is PM', recurringWorkflows({ packs: ['core', 'av'] }).map(w => w.id).join() === 'maintenance')
log('a QLD team\'s are its two checks, the smoke alarms fixed by law',
  recurringWorkflows({ packs: ['core', 'qld_electrical'] }).map(w => `${w.id}:${w.interval.fixed}`).join() === 'qld_smoke_alarm:true,qld_electrical_safety:false')
log('a blank interval follows the team default, else the pack\'s, else isn\'t tracked',
  fallbackText(workflow('qld_electrical_safety'), 36) === 'every 36 months, the team default' &&
    fallbackText(workflow('qld_electrical_safety'), null) === 'every 24 months, the pack default' &&
    fallbackText(workflow('maintenance'), null) === 'not tracked as due')
log('one month reads as such', everyText(1) === 'every month' && everyText(6) === 'every 6 months')
log('an interval is a whole number of months from 1 to 120, or blank',
  readMonths(' 12 ').months === 12 && readMonths('').months === null && !!readMonths('0').error && !!readMonths('121').error && !!readMonths('1.5').error)

// ── The stand-in database ───────────────────────────────────────────────────
const localhost = new URL(BASE).hostname
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const db = { intervals: [], rpcs: [], refuse: null }
async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
  if (url.pathname === '/rest/v1/workflow_intervals' && req.method() === 'GET') return json(200, db.intervals)
  if (url.pathname === '/rest/v1/rpc/set_workflow_interval') {
    const body = JSON.parse(req.postData())
    db.rpcs.push(body)
    if (db.refuse) return json(400, db.refuse)
    db.intervals = db.intervals.filter(r => !(r.workflow_id === body.p_workflow_id && r.client_id === body.p_client_id))
    if (body.p_months != null) db.intervals.push({ workflow_id: body.p_workflow_id, client_id: body.p_client_id, interval_months: body.p_months })
    return route.fulfill({ status: 204, headers: cors })
  }
  return route.abort()
}

const ELECTRICAL = {
  enforced: false, accountType: 'provider', plan: 'pro', isPro: true, seatLimit: 1, seatsUsed: 1,
  visitLimit: null, visitsUsed: 0, packs: ['core', 'qld_electrical'], pastDueUntil: null,
  cancelAt: null, importUsed: false, openVisits: 0, starterPack: 'qld_electrical', starterInUse: true,
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  await ctx.route('**/*', backend)
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  const settings = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.settings') ?? '{}'))
  const main = () => page.textContent('main')
  // The team's packs, as the app reads them once signed in.
  const holds = entitlements =>
    page.evaluate(async e => {
      const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
      const mod = await import(url ?? '/src/lib/entitlements.js')
      await mod.openEntitlements('team', 'user', { getEntitlements: async () => e })
    }, entitlements)
  const goto = async hash => {
    await page.goto(BASE + hash, { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(seed => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
    localStorage.removeItem('fc.templates')
    localStorage.setItem('fc.settings', JSON.stringify({ technician: 'Sam Sparks', company: { name: 'Sparks Electrical' } }))
  }, SEED)

  // ── An AV team ──────────────────────────────────────────────────────────────
  await goto('#/settings')
  let text = await main()
  log('an AV team\'s Settings don\'t ask for licence numbers',
    (await page.getByLabel('REC number').count()) === 0 && (await page.getByLabel('Your licence or registration number').count()) === 0)
  log('but do have the reminders switch, on', (await page.getByLabel('Send re-check reminders').isChecked()) && /Reminders/.test(text))

  // ── A team doing electrical checks ─────────────────────────────────────────
  await holds(ELECTRICAL)
  await page.getByLabel('Licence number', { exact: true }).fill('LIC-4410')
  await page.getByLabel('REC number').fill('REC-2201')
  await page.getByLabel('Your licence or registration number').fill('QLD-77')
  let saved = await settings()
  log('the company\'s licence and REC numbers are kept with its details',
    saved.company?.licence_number === 'LIC-4410' && saved.company.rec_number === 'REC-2201' && saved.company.name === 'Sparks Electrical', JSON.stringify(saved.company))
  log('and the technician\'s own licence number with theirs', saved.licenceNumber === 'QLD-77' && saved.technician === 'Sam Sparks')
  await page.getByLabel('Send re-check reminders').uncheck()
  saved = await settings()
  log('reminders can be switched off for the whole team', saved.remindersEnabled === false)
  await page.screenshot({ path: `${DIR}/client-settings-settings.png`, fullPage: true })
  await page.reload({ waitUntil: 'networkidle' })
  await holds(ELECTRICAL)
  log('all of it stays after a reload',
    (await page.getByLabel('REC number').inputValue()) === 'REC-2201' && !(await page.getByLabel('Send re-check reminders').isChecked()))

  // The sign-off starts from the technician's own number.
  await goto('#/qld-smoke-alarm')
  await holds(ELECTRICAL)
  await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
  await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  await page.getByRole('button', { name: 'Start smoke alarm inspection' }).click()
  await page.getByRole('button', { name: 'Finish visit' }).click()
  log('the sign-off fills in the technician\'s licence number',
    (await page.getByRole('dialog').getByLabel('Licence or registration number').inputValue()) === 'QLD-77')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  // The report names the business's numbers.
  const download = page.waitForEvent('download', { timeout: 15000 })
  await page.evaluate(async () => {
    // Straight to the workbook: exporting an open check asks for a sign-off first.
    const report = await import('/src/lib/report.js')
    const settings = JSON.parse(localStorage.getItem('fc.settings'))
    const wb = await report.buildWorkbook({
      client: { name: 'Rental Co' }, location: { address: '10 Smith St' }, visit: { rooms: {} }, rooms: [], revision: 1, settings,
    })
    report.triggerDownload(await wb.xlsx.writeBuffer(), 'check.xlsx')
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(await (await download).path())
  const rows = []
  wb.worksheets[0].eachRow(r => rows.push(String(r.getCell(1).value ?? '')))
  log('the report prints the business\'s licence and REC numbers beside its contact details',
    rows.some(r => /Licence LIC-4410 {2}· {2}REC REC-2201/.test(r)), rows.slice(0, 4).join(' / '))

  // ── A client's contact and reminders (C3b) ─────────────────────────────────
  const client = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients'))[0])
  const card = () => page.getByRole('region', { name: 'Rental Co details' })
  await goto('#/edit-client')
  await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
  log('a client picked on Edit Client shows its contact, above its sites',
    (await card().count()) === 1 && (await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).count()) === 1)
  await card().getByLabel('Contact name').fill('Jane Citizen')
  await card().getByLabel('Contact phone').fill('0400 111 222')
  await card().getByLabel('Contact email').fill('jane.example.com')
  log('an address that isn\'t an email says so', /doesn't look like an email address/.test(await card().textContent()))
  await card().getByLabel('Contact email').fill('jane@example.com')
  log('and stops once it is', !/doesn't look like an email address/.test(await card().textContent()))
  let c = await client()
  log('the contact is saved with the client as it\'s typed',
    c.contactName === 'Jane Citizen' && c.contactPhone === '0400 111 222' && c.contactEmail === 'jane@example.com', JSON.stringify(c))
  log('with the team\'s reminders off, the card says none go out',
    /switched off for the whole team in Settings/.test(await card().textContent()))
  await card().getByLabel('Send this client re-check reminders').uncheck()
  c = await client()
  log('a client\'s reminders can be switched off on their own', c.remindersEnabled === false)
  await page.screenshot({ path: `${DIR}/client-settings-client.png` })
  await goto('#/edit-client')
  await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
  log('it all stays after a reload',
    (await card().getByLabel('Contact name').inputValue()) === 'Jane Citizen' && !(await card().getByLabel('Send this client re-check reminders').isChecked()))
  await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  log('and the site still opens to edit', (await page.getByRole('textbox', { name: 'Address', exact: true }).inputValue()) === '10 Smith St')
  await goto('#/new-client')
  log('New Client is unchanged: no contact fields', (await page.getByLabel('Contact email').count()) === 0)

  // What follows asks the database, answered here, so it needs a backend address
  // in .env, as the other suites' database checks do. CI has none.
  const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
  if (!configured) {
    console.log('(the interval checks need VITE_SUPABASE_URL in .env, and were skipped)')
  } else {
    // ── How often checks are due (C3c) ─────────────────────────────────────────
    const shown = scope => scope.getByText('Saved. Due dates have moved to match.').waitFor().then(() => true, () => false)
    await goto('#/settings')
    log('with no team, the interval waits for one', /How often checks are due[\s\S]*Set once you're signed in to a team/.test(await main()))
    await holds(ELECTRICAL)
    const elec = () => page.getByLabel('QLD electrical safety: every how many months')
    await elec().waitFor()
    log('a QLD team sets its electrical check, and is told the smoke alarms are set by law',
      (await elec().count()) === 1 && /QLD smoke alarms — every 12 months, set by law/.test(await main()) &&
        (await page.getByLabel('QLD smoke alarms: every how many months').count()) === 0)
    log('a blank one says it follows the pack\'s default', /Left blank: every 24 months, the pack default\./.test(await main()))
    await elec().fill('0')
    log('0 months is refused before anything is sent', /Between 1 and 120 months/.test(await main()) && db.rpcs.length === 0)
    await elec().fill('36')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    log('the team default goes to the database, which moves the due dates',
      (await shown(page)) &&
        JSON.stringify(db.rpcs.at(-1)) === '{"p_team_id":"team","p_workflow_id":"qld_electrical_safety","p_client_id":null,"p_months":36}',
      JSON.stringify(db.rpcs.at(-1)))
    // The row starts again from what the database now holds; the word stays.
    await page.waitForTimeout(800)
    log('and still says so once it has read the value back',
      (await page.getByText('Saved. Due dates have moved to match.').count()) === 1 && (await elec().inputValue()) === '36')
    await page.screenshot({ path: `${DIR}/client-settings-intervals.png`, fullPage: true })
    await goto('#/settings')
    await holds(ELECTRICAL)
    await elec().waitFor()
    log('and is read back from it', (await elec().inputValue()) === '36')

    // A client's own.
    await goto('#/edit-client')
    await holds(ELECTRICAL)
    await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
    const own = () => card().getByLabel('QLD electrical safety: every how many months')
    await own().waitFor()
    log('a client with none of its own follows the team default', /Left blank: every 36 months, the team default\./.test(await card().textContent()))
    await own().fill('12')
    await card().getByRole('button', { name: 'Save', exact: true }).click()
    log('its own goes in for that client only', (await shown(card())) && db.rpcs.at(-1)?.p_client_id === 'c1' && db.rpcs.at(-1).p_months === 12)
    await own().fill('')
    await card().getByRole('button', { name: 'Save', exact: true }).click()
    log('and cleared, it goes back to the team default',
      (await shown(card())) && db.rpcs.at(-1)?.p_client_id === 'c1' && db.rpcs.at(-1).p_months === null && !db.intervals.some(r => r.client_id === 'c1'))

    // Refused, and offline.
    db.refuse = { code: 'P0001', message: 'Only an owner or admin can set how often a check is done', hint: null, details: null }
    await own().fill('6')
    await card().getByRole('button', { name: 'Save', exact: true }).click()
    log('the database\'s refusal is shown',
      await card().getByRole('alert').filter({ hasText: 'Only an owner or admin' }).waitFor().then(() => true, () => false))
    db.refuse = null
    const asked = db.rpcs.length
    await ctx.setOffline(true)
    await card().getByRole('button', { name: 'Save', exact: true }).click()
    log('with no signal it says it needs a connection, and sends nothing',
      /needs a connection/.test(await card().getByRole('alert').textContent()) && db.rpcs.length === asked)
    await ctx.setOffline(false)

    // An AV team's PM.
    await goto('#/settings')
    await holds({ ...ELECTRICAL, packs: ['core', 'av'], starterPack: 'av' })
    await page.getByLabel('Preventative Maintenance: every how many months').waitFor()
    log('an AV team sets how often PM visits are due, which has no default',
      /Left blank: not tracked as due\./.test(await main()) && (await elec().count()) === 0)
  }

} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
