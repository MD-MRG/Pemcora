/**
 * Step C3: licence numbers, reminders and how often checks are due, in Settings
 * and on a client.
 *
 * In a browser in test mode. A team's packs are put in place as the app reads
 * them, so an AV team and one doing electrical checks can both be looked at.
 *
 *   node tests/client-settings.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - a team whose checks are signed off records the company's licence and REC
 *     numbers, which print on its reports, and each technician's own licence
 *     number, which fills in the sign-off
 *   - an AV team's Settings don't ask for licence numbers
 *   - re-check reminders can be switched off for the whole team
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

const ELECTRICAL = {
  enforced: false, accountType: 'provider', plan: 'pro', isPro: true, seatLimit: 1, seatsUsed: 1,
  visitLimit: null, visitsUsed: 0, packs: ['core', 'qld_electrical'], pastDueUntil: null,
  cancelAt: null, importUsed: false, openVisits: 0, starterPack: 'qld_electrical', starterInUse: true,
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true })
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
  log('and the site still opens to edit', (await page.getByLabel('Address', { exact: true }).inputValue()) === '10 Smith St')
  await goto('#/new-client')
  log('New Client is unchanged: no contact fields', (await page.getByLabel('Contact email').count()) === 0)
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
