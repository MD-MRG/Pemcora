/**
 * Step D4b: a landlord's Reports page.
 *
 * In a browser in test mode, as a landlord account, with received_reports() and
 * the report bucket answered here as the database would answer them. The
 * account's properties are its own, on the device. Nothing reaches the live
 * project.
 *
 *   node tests/reports.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the page to:
 *   - the account's reports, asked for by its team, the ones not filed first
 *   - each says what, from whom, where, when and how it went, and where it's filed
 *   - its PDF opens through the account's own access; one sent without says so
 *   - filing makes the property in the device's copy, under its owner, then files
 *   - a filed report can be moved; one whose site files itself can stop that
 *   - no reports, and no connection, each say so
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'
const localhost = new URL(BASE).hostname

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const TEAM = '44444444-4444-4444-8444-444444444444'
const LANDLORD = { enforced: false, accountType: 'landlord', plan: 'free', isPro: false, packs: ['core'], starterPack: null, starterInUse: false }

// The account's own properties, on the device.
const SEED = [
  { id: 'c-rental', name: 'Rental Co', contactName: '', contactEmail: '', contactPhone: '', remindersEnabled: true, locations: [{ id: 'loc-other', address: '5 Other St', suburb: 'Kew', city: '', state: 'VIC', postcode: '3101', floors: [], visits: [], assets: [] }] },
  { id: 'c-pat', name: 'Pat Owner', contactName: '', contactEmail: '', contactPhone: '', remindersEnabled: true, locations: [{ id: 'loc-filed', address: '10 Smith St', suburb: 'Toowong', city: '', state: 'QLD', postcode: '4066', floors: [], visits: [], assets: [] }] },
]

const snap = (title, business) => ({ reportTitle: title, client: 'Rental Co', provider: { name: `${business} team`, company: { name: business } }, site: { failed: [] }, rooms: [] })
const ROWS = () => [
  { id: 'r-old', token: 't3', workflow_id: 'vic_smoke_alarm', workflow: 'Smoke alarm safety check', completed_on: '2026-09-01', outcome: 'compliant', site: { address: '5 Other St', suburb: 'Kew', state: 'VIC', postcode: '3101' }, snapshot: snap('Smoke Alarm Safety Check', 'Old Sparks'), has_file: false, file_path: null, recipient_team_id: TEAM, recipient_location_id: 'loc-other', sent_at: '2026-09-02T00:00:00Z', files_itself: false },
  { id: 'r-filed', token: 't2', workflow_id: 'qld_smoke_alarm', workflow: 'Smoke alarm compliance inspection', completed_on: '2026-11-01', outcome: 'compliant', site: { address: '10 Smith St', suburb: 'Toowong', state: 'QLD', postcode: '4066' }, snapshot: snap('Smoke Alarm Compliance Inspection', 'Sparky Co'), has_file: true, file_path: 'team-p/filed.pdf', recipient_team_id: TEAM, recipient_location_id: 'loc-filed', sent_at: '2026-11-02T00:00:00Z', files_itself: true },
  { id: 'r-new', token: 't1', workflow_id: 'vic_electrical_safety', workflow: 'Electrical safety check', completed_on: '2026-11-06', outcome: 'non_compliant', site: { address: '22 New Rd', suburb: 'Kew', state: 'VIC', postcode: '3101' }, snapshot: snap('Electrical Safety Check', 'Volt Bros'), has_file: true, file_path: 'team-v/new.pdf', recipient_team_id: TEAM, recipient_location_id: null, sent_at: '2026-11-07T00:00:00Z', files_itself: false },
]

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const server = { rows: ROWS(), calls: [], down: false }
async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
  const body = req.postData() ? JSON.parse(req.postData()) : null
  server.calls.push({ path: url.pathname, search: decodeURIComponent(url.search), body })
  if (server.down) return route.abort('internetdisconnected')
  if (url.pathname === '/rest/v1/rpc/received_reports') {
    const sorted = server.rows.slice().sort((a, b) => b.sent_at.localeCompare(a.sent_at))
    return reply(200, sorted)
  }
  if (url.pathname === '/rest/v1/rpc/file_report') {
    const r = server.rows.find(x => x.id === body.p_delivery_id)
    if (r) r.recipient_location_id = body.p_location_id
    return reply(200, r ?? {})
  }
  if (url.pathname === '/rest/v1/rpc/stop_auto_filing') {
    const r = server.rows.find(x => x.id === body.p_delivery_id)
    if (r) r.files_itself = false
    return route.fulfill({ status: 204, headers: cors })
  }
  if (url.pathname.startsWith('/storage/v1/object/sign/reports/') && req.method() === 'POST') {
    return reply(200, { signedURL: `/object/sign/reports/${url.pathname.slice('/storage/v1/object/sign/reports/'.length)}?token=acct` })
  }
  if (url.pathname.startsWith('/storage/v1/object/sign/reports/')) return route.fulfill({ status: 200, contentType: 'application/pdf', headers: cors, body: '%PDF-1.4 %%EOF' })
  return route.abort()
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  await ctx.route('**/*', backend)
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
  const main = () => page.textContent('main')
  const calls = path => server.calls.filter(c => c.path === path)
  const asLandlord = () =>
    page.evaluate(
      async ({ team, e }) => {
        const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
        const mod = await import(url ?? '/src/lib/entitlements.js')
        await mod.openEntitlements(team, 'user', { getEntitlements: async () => e })
      },
      { team: TEAM, e: LANDLORD },
    )
  const openReports = async () => {
    await page.goto(BASE + '#/reports', { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
  }
  const card = text => page.locator('li').filter({ hasText: text })

  await page.evaluate(seed => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
  }, SEED)

  if (!configured) {
    console.log('(the Reports checks need VITE_SUPABASE_URL in .env, and were skipped; nothing is sent there)')
  } else {
    await openReports()
    log('with no account it says reports are kept with one', /Reports are kept with an account/.test(await main()))
    log('…and asks the database nothing', calls('/rest/v1/rpc/received_reports').length === 0)

    await asLandlord()
    log('a landlord sees its reports', await until(async () => /Not filed yet \(1\)/.test(await main())))
    log('…asked for by its own account', /recipient_team_id=eq\.44444444/.test(calls('/rest/v1/rpc/received_reports').at(-1)?.search ?? ''))
    const text = await main()
    log('the ones not filed come first', text.indexOf('Volt Bros') < text.indexOf('Sparky Co') && text.indexOf('Not filed yet') < text.indexOf('Filed'))
    log('each says what, from whom, where, when and how it went',
      /Electrical Safety Check · Volt Bros/.test(text) && /22 New Rd, Kew VIC 3101 · Done 6 November 2026 · Non-compliant/.test(text))
    log('…and where it is filed, by the account\'s own properties', /Filed under 10 Smith St, Toowong QLD 4066/.test(await card('Sparky Co').textContent()))
    log('a report whose site files itself says so', /Later reports from Sparky Co for this property file themselves/.test(await card('Sparky Co').textContent()))
    log('one sent without a PDF says so', /sent without a PDF/.test(await card('Old Sparks').textContent()))
    await page.screenshot({ path: `${DIR}/reports.png`, fullPage: true })

    // The PDF.
    const popup = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null)
    await card('Sparky Co').getByRole('button', { name: /Open the PDF/ }).click()
    const tab = await popup
    if (tab) await until(async () => tab.url().includes('token=acct'))
    log('its PDF opens through the account\'s own access', /\/storage\/v1\/object\/sign\/reports\/team-p\/filed\.pdf\?token=acct$/.test(tab?.url() ?? ''), tab?.url())
    await tab?.close()

    // File the new one under a new property, made on the device.
    await card('Volt Bros').getByRole('button', { name: 'File it' }).click()
    log('filing offers a new property at the report\'s address', await until(async () => /A new property: 22 New Rd, Kew VIC 3101/.test(await card('Volt Bros').textContent())))
    log('…under its owner, the electrician\'s name for their client', (await card('Volt Bros').getByRole('textbox').inputValue()) === 'Rental Co')
    log('…or one of the account\'s properties', /5 Other St, Kew/.test(await card('Volt Bros').textContent()) && /10 Smith St, Toowong/.test(await card('Volt Bros').textContent()))
    await card('Volt Bros').getByRole('button', { name: 'File it', exact: true }).last().click()
    log('filed, it moves down with the rest', await until(async () => !/Not filed yet/.test(await main())) && /Filed under 22 New Rd, Kew/.test(await card('Volt Bros').textContent()))
    const device = await page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients')))
    const rental = device.find(c => c.id === 'c-rental')
    const made = rental?.locations.find(l => l.address === '22 New Rd')
    log('the property is in the device\'s copy, under the owner already there', made && device.length === 2 && made.suburb === 'Kew' && made.postcode === '3101')
    log('…and the report is filed under it', calls('/rest/v1/rpc/file_report').at(-1)?.body?.p_location_id === made?.id && calls('/rest/v1/rpc/file_report').at(-1)?.body?.p_delivery_id === 'r-new')

    // Move a filed one.
    await card('Sparky Co').getByRole('button', { name: 'Move' }).click()
    await until(async () => /Choose where it belongs/.test(await card('Sparky Co').textContent()))
    await card('Sparky Co').getByRole('radio', { name: /5 Other St/ }).check()
    await card('Sparky Co').getByRole('button', { name: 'File it', exact: true }).click()
    log('a filed report can be moved to another property', await until(async () => /Filed under 5 Other St, Kew/.test(await card('Sparky Co').textContent()))
      && calls('/rest/v1/rpc/file_report').at(-1)?.body?.p_location_id === 'loc-other')

    // Stop it filing itself.
    await card('Sparky Co').getByRole('button', { name: 'Stop that' }).click()
    const ask = page.getByRole('dialog')
    log('stopping asks first, saying what changes', /Stop reports from Sparky Co filing themselves\?/.test(await ask.textContent()) && /will wait here to be filed/.test(await ask.textContent()))
    await ask.getByRole('button', { name: 'Stop' }).click()
    log('…then stops it, for that report\'s site', await until(async () => !/file themselves/.test(await card('Sparky Co').textContent()))
      && calls('/rest/v1/rpc/stop_auto_filing').at(-1)?.body?.p_delivery_id === 'r-filed')

    // None, and no connection.
    server.rows = []
    await openReports()
    await asLandlord()
    log('with no reports it says how they arrive', await until(async () => /No reports yet/.test(await main())) && /open the link in their email and save it/.test(await main()))
    server.rows = ROWS()
    server.down = true
    await openReports()
    await asLandlord()
    log('with no connection it says so', await until(async () => /Reports need a connection/.test(await main())))
    server.down = false
    await page.getByRole('button', { name: 'Try again' }).click()
    log('…and shows them once there is one', await until(async () => /Volt Bros/.test(await main())))
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
