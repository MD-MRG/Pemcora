/**
 * Step D4c: a landlord's Properties page.
 *
 * src/lib/properties.js in Node, then the page in a browser in test mode, as a
 * landlord account: its properties on the device, and compliance_items,
 * received_reports() and the report bucket answered here as the database would.
 * Nothing reaches the live project.
 *
 *   node tests/properties.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the page to:
 *   - each property, by address, under its owner
 *   - what's due there, overdue first, with when it was last done
 *   - the reports filed under it, newest first, each opening its PDF
 *   - a site that files its reports here by itself says so, and can stop
 *   - a property added on the device, under an owner already there or a new one;
 *     the same address twice is refused
 *   - with no connection the properties still show, and the page says what's missing
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

// ── The helper ──────────────────────────────────────────────────────────────
const P = await import('../src/lib/properties.js')
const TODAY = '2026-11-09'
log('a check past its date is overdue', P.checkState('2026-11-08', TODAY) === 'overdue')
log('…on its date, or within 60 days, it is due soon', P.checkState('2026-11-09', TODAY) === 'soon' && P.checkState('2027-01-08', TODAY) === 'soon')
log('…after that, fine; with no date, unknown', P.checkState('2027-01-09', TODAY) === 'ok' && P.checkState(null, TODAY) === 'unknown')

const CLIENTS = [
  { id: 'c-pat', name: 'Pat Owner', locations: [{ id: 'loc-b', address: '9 Zed St', suburb: 'Kew', state: 'VIC', postcode: '3101' }] },
  { id: 'c-rental', name: 'Rental Co', locations: [{ id: 'loc-a', address: '10 Smith St', suburb: 'Toowong', state: 'QLD', postcode: '4066' }] },
]
const ITEMS = [
  { id: 'i1', location_id: 'loc-a', label: 'Smoke alarm compliance inspection', interval_months: 12, last_done_on: '2025-11-01', next_due_on: '2026-11-01', active: true, satisfied_by: 'qld_smoke_alarm' },
  { id: 'i2', location_id: 'loc-a', label: 'Gas check', interval_months: 24, last_done_on: '2025-01-01', next_due_on: '2027-01-01', active: true },
  { id: 'i3', location_id: 'loc-a', label: 'Electrical safety check', interval_months: 24, last_done_on: '2026-06-01', next_due_on: '2028-06-01', active: true },
  { id: 'i4', location_id: 'loc-a', label: 'Retired check', interval_months: 12, next_due_on: '2026-01-01', active: false },
  { id: 'i5', location_id: 'gone', label: 'Somewhere else', interval_months: 12, next_due_on: '2026-01-01', active: true },
]
const snap = (title, business) => ({ reportTitle: title, client: 'Rental Co', provider: { name: `${business} team`, company: { name: business } } })
const REPORTS = [
  { id: 'r2', completed_on: '2026-11-01', outcome: 'compliant', site: {}, snapshot: snap('Smoke Alarm Compliance Inspection', 'Sparky Co'), has_file: true, file_path: 'team-p/two.pdf', recipient_location_id: 'loc-a', files_itself: true },
  { id: 'r1', completed_on: '2025-11-01', outcome: 'compliant', site: {}, snapshot: snap('Smoke Alarm Compliance Inspection', 'Sparky Co'), has_file: false, file_path: null, recipient_location_id: 'loc-a', files_itself: true },
  { id: 'r3', completed_on: '2026-06-01', outcome: 'non_compliant', site: {}, snapshot: snap('Electrical Safety Check', 'Volt Bros'), has_file: true, file_path: 'team-v/three.pdf', recipient_location_id: 'loc-a', files_itself: false },
  { id: 'r9', completed_on: '2026-06-01', outcome: 'compliant', site: {}, snapshot: snap('X', 'Y'), has_file: true, file_path: 'z.pdf', recipient_location_id: null, files_itself: false },
]
const cards = P.propertyCards(CLIENTS, ITEMS, REPORTS, TODAY)
log('properties come by address, each under its owner', cards.map(c => `${c.address}|${c.owner}`).join(' / ') === '10 Smith St, Toowong QLD 4066|Rental Co / 9 Zed St, Kew VIC 3101|Pat Owner', cards.map(c => c.address).join(' / '))
const smith = cards[0]
log('what\'s due comes overdue first, then soon, then later', smith.checks.map(c => c.state).join() === 'overdue,soon,ok' && smith.checks[0].label === 'Smoke alarm compliance inspection')
log('…with its dates written out', smith.checks[0].nextDue === '1 November 2026' && smith.checks[0].lastDone === '1 November 2025')
log('…leaving out a check switched off, and one for a property not here', smith.checks.length === 3 && !cards.some(c => c.checks.some(k => k.label === 'Somewhere else')))
log('reports filed here come newest first; one not filed is nowhere', smith.reports.map(r => r.id).join() === 'r2,r3,r1' && !cards.some(c => c.reports.some(r => r.id === 'r9')))
log('a business whose site files here by itself is named once, by its latest report', JSON.stringify(smith.selfFiling) === JSON.stringify([{ business: 'Sparky Co', deliveryId: 'r2' }]))
log('a property with nothing on record is still listed', cards[1].checks.length === 0 && cards[1].reports.length === 0)
log('owners for the form, each once', JSON.stringify(P.ownersOf([...CLIENTS, { name: 'Pat Owner' }])) === JSON.stringify(['Pat Owner', 'Rental Co']))

// ── The page ────────────────────────────────────────────────────────────────
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const TEAM = '55555555-5555-4555-8555-555555555555'
const LANDLORD = { enforced: false, accountType: 'landlord', plan: 'free', isPro: false, packs: ['core'], starterPack: null, starterInUse: false }
const SEED = CLIENTS.map(c => ({ ...c, contactName: '', contactEmail: '', contactPhone: '', remindersEnabled: true, locations: c.locations.map(l => ({ ...l, city: '', floors: [], visits: [], assets: [] })) }))

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const server = { items: ITEMS.map(i => ({ ...i, next_due_on: i.next_due_on })), reports: REPORTS.map(r => ({ ...r, recipient_team_id: TEAM })), calls: [], down: false }
async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
  const body = req.postData() ? JSON.parse(req.postData()) : null
  server.calls.push({ path: url.pathname, search: decodeURIComponent(url.search), body })
  if (server.down) return route.abort('internetdisconnected')
  if (url.pathname === '/rest/v1/compliance_items') return reply(200, server.items)
  if (url.pathname === '/rest/v1/rpc/received_reports') return reply(200, server.reports)
  if (url.pathname === '/rest/v1/rpc/stop_auto_filing') {
    for (const r of server.reports) if (r.snapshot.provider.company.name === 'Sparky Co') r.files_itself = false
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
  const property = address => page.getByRole('listitem', { name: address })
  const asLandlord = () =>
    page.evaluate(
      async ({ team, e }) => {
        const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
        const mod = await import(url ?? '/src/lib/entitlements.js')
        await mod.openEntitlements(team, 'user', { getEntitlements: async () => e })
      },
      { team: TEAM, e: LANDLORD },
    )
  const openProperties = async () => {
    await page.goto(BASE + '#/properties', { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await asLandlord()
  }
  await page.evaluate(seed => localStorage.setItem('fc.clients', JSON.stringify(seed)), SEED)

  if (!configured) {
    console.log('(the page checks need VITE_SUPABASE_URL in .env, and were skipped; nothing is sent there)')
  } else {
    await openProperties()
    log('each property shows, by address, under its owner', await until(async () => /10 Smith St, Toowong QLD 4066/.test(await main()))
      && (await main()).indexOf('10 Smith St') < (await main()).indexOf('9 Zed St') && /Rental Co/.test(await property('10 Smith St, Toowong QLD 4066').textContent()))
    log('…asking the database for its own account only', /team_id=eq\.55555555/.test(calls('/rest/v1/compliance_items').at(-1)?.search ?? '') && /recipient_team_id=eq\.55555555/.test(calls('/rest/v1/rpc/received_reports').at(-1)?.search ?? ''))
    await until(async () => /Overdue since/.test(await main()))
    const smith = await property('10 Smith St, Toowong QLD 4066').textContent()
    log('what\'s due shows, overdue first, with when it was last done',
      /Smoke alarm compliance inspectionOverdue since 1 November 2026 · last done 1 November 2025/.test(smith) && smith.indexOf('Overdue since') < smith.indexOf('Gas check') && smith.indexOf('Gas check') < smith.indexOf('Electrical safety check'))
    log('…a check switched off is left out', !/Retired check/.test(smith))
    log('the reports filed there show, newest first', /Reports on file/.test(smith) && smith.indexOf('1 November 2026') < smith.indexOf('1 June 2026'))
    log('…one sent without a PDF says so', /sent without a PDF/.test(smith))
    log('a property with nothing on record says how checks arrive', /A saved report adds its check/.test(await property('9 Zed St, Kew VIC 3101').textContent()))
    await page.screenshot({ path: `${DIR}/properties.png`, fullPage: true })

    const popup = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null)
    await property('10 Smith St, Toowong QLD 4066').getByRole('button', { name: /Open the PDF of Smoke Alarm Compliance Inspection, 1 November 2026/ }).click()
    const tab = await popup
    if (tab) await until(async () => tab.url().includes('token=acct'))
    log('a report\'s PDF opens through the account\'s own access', /\/object\/sign\/reports\/team-p\/two\.pdf\?token=acct$/.test(tab?.url() ?? ''), tab?.url())
    await tab?.close()

    log('a site that files here by itself is named once', ((smith.match(/Reports from Sparky Co for this property file themselves/g) ?? []).length === 1) && !/Volt Bros for this property file/.test(smith))
    await property('10 Smith St, Toowong QLD 4066').getByRole('button', { name: 'Stop that' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Stop' }).click()
    log('"Stop that" stops it, named by its latest report', await until(async () => !/file themselves/.test(await main())) && calls('/rest/v1/rpc/stop_auto_filing').at(-1)?.body?.p_delivery_id === 'r2')

    // Adding a property.
    await page.getByRole('button', { name: '+ Add a property' }).click()
    await page.getByLabel('Owner').fill('rental co')
    await page.getByLabel('Street address').fill('22 New Rd')
    await page.getByLabel('Suburb').fill('Kew')
    await page.getByLabel('State').selectOption('VIC')
    await page.getByLabel('Postcode').fill('3101')
    await page.getByRole('button', { name: 'Add property' }).click()
    log('an added property shows at once', await until(async () => /22 New Rd, Kew VIC 3101/.test(await main())))
    let device = await page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients')))
    log('…kept on the device, under the owner already there', device.length === 2 && device.find(c => c.id === 'c-rental')?.locations.some(l => l.address === '22 New Rd' && l.state === 'VIC'))
    await page.getByRole('button', { name: '+ Add a property' }).click()
    await page.getByLabel('Owner').fill('Rental Co')
    await page.getByLabel('Street address').fill('22 new rd')
    await page.getByLabel('Suburb').fill('KEW')
    await page.getByRole('button', { name: 'Add property' }).click()
    log('the same address again is refused, saying so', await until(async () => /is already a property of Rental Co/.test(await main())))
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: '+ Add a property' }).click()
    await page.getByLabel('Owner').fill('Sam New')
    await page.getByLabel('Street address').fill('1 Fresh St')
    await page.getByLabel('Suburb').fill('Kew')
    await page.getByRole('button', { name: 'Add property' }).click()
    await until(async () => /1 Fresh St, Kew/.test(await main()))
    device = await page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients')))
    log('a new owner\'s name makes a new owner', device.length === 3 && device.some(c => c.name === 'Sam New' && c.locations[0]?.address === '1 Fresh St'))

    // No connection.
    server.down = true
    await openProperties()
    log('with no connection the properties still show', await until(async () => /10 Smith St, Toowong/.test(await main())))
    log('…and the page says what needs one', await until(async () => /What’s due and the reports on file need a connection/.test(await main())))
    server.down = false
    await page.getByRole('button', { name: 'Try again' }).click()
    log('…showing it once there is one', await until(async () => /Overdue since/.test(await main())))

    // None.
    await page.evaluate(() => localStorage.setItem('fc.clients', '[]'))
    await openProperties()
    log('with no properties it says how they arrive', await until(async () => /No properties yet/.test(await main())))
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
