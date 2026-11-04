/**
 * Step C1f: signing off an electrical or smoke alarm check.
 *
 * In a browser in test mode: a Queensland smoke alarm inspection finished by
 * signing off, the report it exports, a correction signed again, and an AV visit
 * finished as it always was.
 *
 *   node tests/signoff.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - a check that ends in a sign-off can't finish, or export, without one
 *   - the sign-off needs an outcome, a name, a licence number and a signature
 *   - all four are kept with the visit, the signature as a path well under 50 KB
 *   - the report says the outcome and who signed it; an AV report doesn't change
 *   - a correction is signed again, starting from what was signed before
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

// Every row of the report's first sheet, as text.
async function reportRows(download) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(await download.path())
  const rows = []
  wb.worksheets[0].eachRow(row => rows.push(row.values.filter(v => v != null).map(String).join(' | ')))
  return rows
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients'))[0].locations[0])
  const openSite = async path => {
    await page.goto(BASE + path, { waitUntil: 'networkidle' })
    // The same address again keeps the page where it was: start it afresh.
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
    await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  }
  const dialog = () => page.getByRole('dialog')
  const signButton = () => dialog().getByRole('button', { name: 'Sign and finish' })
  // A signature, drawn across the pad with the mouse.
  const sign = async () => {
    const pad = dialog().getByRole('img', { name: /Signature/ })
    const box = await pad.boundingBox()
    await page.mouse.move(box.x + 30, box.y + box.height * 0.6)
    await page.mouse.down()
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(box.x + 30 + i * 15, box.y + box.height * (0.6 + 0.2 * Math.sin(i / 2)))
    }
    await page.mouse.up()
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(seed => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
    localStorage.removeItem('fc.templates')
    localStorage.setItem('fc.settings', JSON.stringify({ technician: 'Sam Sparks', licenceNumber: 'QLD-77' }))
  }, SEED)

  await openSite('#/qld-smoke-alarm')
  await page.getByRole('button', { name: 'Start smoke alarm inspection' }).click()
  await page.getByRole('button', { name: 'Finish visit' }).click()
  log('finishing a smoke alarm inspection asks for a sign-off', (await dialog().getAttribute('aria-label')) === 'Sign off this smoke alarm inspection')
  log('with the technician and their licence number filled in',
    (await dialog().getByLabel('Name').inputValue()) === 'Sam Sparks' && (await dialog().getByLabel('Licence or registration number').inputValue()) === 'QLD-77')
  log('and can\'t be signed without an outcome or a signature', await signButton().isDisabled())
  await dialog().getByLabel('Compliant', { exact: true }).check()
  log('nor with an outcome but no signature', await signButton().isDisabled())
  await sign()
  await dialog().getByLabel('Licence or registration number').fill('')
  log('nor without a licence number', await signButton().isDisabled())
  await dialog().getByLabel('Licence or registration number').fill('QLD-12345')
  log('with all four it can', !(await signButton().isDisabled()))
  await page.screenshot({ path: `${DIR}/signoff-dialog.png` })
  await signButton().click()

  let visit = (await stored()).visits[0]
  log('signing finishes the visit', !!visit.completedAt && (await dialog().count()) === 0)
  log('and keeps the outcome', visit.outcome === 'compliant')
  log('the name and licence number signed with',
    visit.signoff?.technician === 'Sam Sparks' && visit.signoff.licence_number === 'QLD-12345' && !!visit.signoff.signed_at, JSON.stringify(visit.signoff))
  log('and the signature, as a path well under the database\'s 50 KB',
    /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+$/.test(visit.signoff?.signature ?? '') && new TextEncoder().encode(visit.signoff.signature).length < 51200,
    `${visit.signoff?.signature?.length} characters`)
  log('the visit says how it came out', /Last visit completed .* · Compliant/.test(await page.textContent('main')))

  // The report.
  let download = page.waitForEvent('download', { timeout: 15000 })
  await page.getByRole('button', { name: 'Export report' }).click()
  let rows = await reportRows(await download)
  log('the report says the outcome', rows.some(r => r === 'Outcome | Compliant'), rows.slice(0, 14).join(' / '))
  log('and who signed it, with their licence number', rows.some(r => r === 'Signed off by | Sam Sparks · Licence QLD-12345'))

  // A correction: reopened, and signed again from what was signed before.
  await page.getByRole('button', { name: 'Reopen for editing' }).click()
  await dialog().getByRole('button', { name: 'Reopen' }).click()
  await page.getByRole('button', { name: 'Finish visit' }).click()
  log('a correction is signed again, starting from the last sign-off',
    (await dialog().getByLabel('Licence or registration number').inputValue()) === 'QLD-12345' &&
      (await dialog().getByLabel('Compliant', { exact: true }).isChecked()) && !(await signButton().isDisabled()))
  await dialog().getByLabel('Non-compliant').check()
  await signButton().click()
  visit = (await stored()).visits[0]
  log('and the new outcome is kept', visit.outcome === 'non_compliant' && !!visit.completedAt)

  // Exporting an open check signs it off first.
  await openSite('#/qld-smoke-alarm')
  await page.getByRole('button', { name: 'Start new smoke alarm inspection' }).click()
  await page.getByRole('button', { name: 'Export report' }).click()
  log('exporting an open check asks for the sign-off first', (await dialog().getAttribute('aria-label')) === 'Sign off this smoke alarm inspection')
  await dialog().getByLabel('Non-compliant').check()
  await sign()
  download = page.waitForEvent('download', { timeout: 15000 })
  await signButton().click()
  rows = await reportRows(await download)
  const second = (await stored()).visits.find(v => v.id !== visit.id)
  log('then the report goes, signed', rows.some(r => r === 'Outcome | Non-compliant') && second?.outcome === 'non_compliant' && (second.exports ?? []).length === 1)
  await openSite('#/qld-smoke-alarm')
  await page.getByRole('button', { name: 'Start new smoke alarm inspection' }).click()
  await page.getByRole('button', { name: 'Export report' }).click()
  await dialog().getByRole('button', { name: 'Cancel' }).click()
  const third = (await stored()).visits.find(v => v.id !== visit.id && v.id !== second.id)
  log('cancelled, nothing is finished or exported', !!third && !third.completedAt && !(third.exports ?? []).length)

  // An AV visit finishes as it always has.
  await openSite('#/maintenance')
  await page.getByRole('button', { name: 'Start PM' }).click()
  await page.getByRole('button', { name: 'Finish visit' }).click()
  log('an AV visit finishes with the usual question', (await dialog().getAttribute('aria-label')) === 'Finish this visit?')
  await dialog().getByRole('button', { name: 'Finish visit' }).click()
  const pm = (await stored()).visits.find(v => v.kind === 'maintenance')
  log('and records no outcome or sign-off', !!pm?.completedAt && !pm.outcome && !pm.signoff)
  download = page.waitForEvent('download', { timeout: 15000 })
  await page.getByRole('button', { name: 'Export report' }).click()
  rows = await reportRows(await download)
  log('its report has neither', !rows.some(r => /^Outcome|^Signed off by/.test(r)))
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
