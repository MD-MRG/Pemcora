import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'
import ExcelJS from 'exceljs'

const DIR = process.argv[2] ?? '.'
const BASE = (process.env.PEMCORA_BASE ?? 'http://localhost:5173/')

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }) } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// A 1×1 red PNG, and an oversized buffer to test the size guard.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const BIG = Buffer.concat([PNG, Buffer.alloc(220 * 1024, 0x20)])

const SEED = [
  { id: 'c1', name: 'Equinix', locations: [
    { id: 'l1', address: '8 Grand Avenue', suburb: 'Rosehill', city: 'Sydney', state: 'NSW', postcode: '2142',
      floors: [{ id: 'f1', label: 'Ground', rooms: [{ id: 'r1', name: 'Reception', planNumber: 'G-01' }] }],
      visits: [] },
  ]},
]

const browser = await launch()
const ctx = await testContext(browser, { viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await ctx.newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const settings = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.settings') || '{}'))
const clients = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')

async function goto(route) {
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(120)
  await page.goto(BASE + route, { waitUntil: 'networkidle' })
  await page.waitForTimeout(350)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(s => {
    localStorage.clear()
    localStorage.setItem('fc.clients', JSON.stringify(s))
  }, SEED)

  // 1 · company details save, persist, and reach the brand plate
  await goto('#/settings')
  await page.getByLabel('Company name').fill('Northpoint Audio Visual')
  await page.getByLabel('ABN').fill('12 345 678 901')
  await page.getByLabel('Phone').fill('02 9000 0000')
  await page.getByLabel('Email').fill('service@northpoint.com.au')
  await page.waitForTimeout(400)
  let s = await settings()
  log('company details saved', s.company?.name === 'Northpoint Audio Visual' && s.company?.abn === '12 345 678 901')
  log('brand plate shows the company name', /Northpoint Audio Visual/.test(await body()))

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  log('company details survive a reload',
    (await page.getByLabel('Company name').inputValue()) === 'Northpoint Audio Visual')

  // 3 · oversize file refused
  await page.getByLabel('Full logo').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: BIG })
  await page.waitForTimeout(500)
  log('oversize logo refused with a reason', /Keep logos under 200 KB/.test(await body()))
  s = await settings()
  log('nothing stored after a refusal', !s.logoFull)

  // 2 · upload both logos
  await page.getByLabel('Full logo').setInputFiles({ name: 'full.png', mimeType: 'image/png', buffer: PNG })
  await page.waitForTimeout(500)
  await page.getByLabel('Collapsed logo').setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: PNG })
  await page.waitForTimeout(500)
  s = await settings()
  log('both logos stored', !!s.logoFull?.src && !!s.logoCollapsed?.src)
  log('PNG kept for the report as-is', s.logoFull.reportSrc === s.logoFull.src)
  await page.screenshot({ path: `${DIR}/settings.png` })

  log('full logo shows in the open sidebar',
    (await page.locator('[data-testid="brand-logo-full"]').count()) === 1 &&
    (await page.locator('[data-testid="brand-logo-collapsed"]').count()) === 0)

  // collapse the nav — the square logo should take over
  await page.getByRole('button', { name: /collapse navigation/i }).click()
  await page.waitForTimeout(500)
  log('collapsed logo shows in the rail only',
    (await page.locator('[data-testid="brand-logo-collapsed"]').count()) === 1 &&
    (await page.locator('[data-testid="brand-logo-full"]').count()) === 0)
  await page.getByRole('button', { name: /expand navigation/i }).click()
  await page.waitForTimeout(400)

  // 5 · plate colour still works after moving store
  await page.getByRole('button', { name: 'Background Espresso' }).click()
  await page.waitForTimeout(400)
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--plate-bg').trim())
  log('plate colour applies', (await bg()) === '#2a2119', await bg())
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(450)
  log('plate colour persists in the new store', (await bg()) === '#2a2119' && (await settings()).plate === 'espresso')

  // 6 · technician default → visit → per-visit override
  await page.getByLabel('Default technician').fill('Michal Dolezal')
  await page.waitForTimeout(400)
  log('default technician saved', (await settings()).technician === 'Michal Dolezal')

  await goto('#/maintenance')
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /^Start PM$/ }).click()
  await page.waitForTimeout(500)
  log('new visit inherits the default technician',
    (await page.getByLabel('Technician').inputValue()) === 'Michal Dolezal')

  await page.getByLabel('Technician').fill('Jamie Martin')
  await page.waitForTimeout(500)
  let v = (await clients())[0].locations[0].visits[0]
  log('per-visit override saved', v.technician === 'Jamie Martin', v.technician)
  log('the Settings default is untouched', (await settings()).technician === 'Michal Dolezal')

  // 7 · report carries branding, technician and an embedded image
  await page.getByRole('button', { name: /Reception/ }).click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Correct Time and Date: PASS' }).click()
  await page.waitForTimeout(250)
  await page.getByRole('button', { name: /^List$/ }).click()
  await page.waitForTimeout(400)

  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /^Export report$/ }).click(),
  ])
  const out = `${DIR}/settings-report.xlsx`
  await dl.saveAs(out)
  let wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(out)
  let ws = wb.worksheets[0]
  const rows = []
  ws.eachRow({ includeEmpty: true }, r => rows.push(String(r.getCell(1).value ?? '') + '|' + String(r.getCell(2).value ?? '')))
  let text = rows.join('\n')
  log('report carries the company name', /Northpoint Audio Visual/.test(text))
  log('report carries ABN, phone and email',
    /12 345 678 901/.test(text) && /02 9000 0000/.test(text) && /service@northpoint\.com\.au/.test(text))
  log('report carries the visit technician', /Technician\|Jamie Martin/.test(text))
  log('logo embedded in the workbook', ws.getImages().length === 1, `${ws.getImages().length} image(s)`)

  // 8 · no logo → report still fine, details as text
  await goto('#/settings')
  await page.getByRole('button', { name: /^Remove$/ }).first().click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^Remove$/ }).first().click()
  await page.waitForTimeout(400)
  s = await settings()
  log('remove clears both logos', !s.logoFull && !s.logoCollapsed)
  log('built-in mark returns', (await page.locator('[data-testid="brand-logo-full"]').count()) === 0)

  await goto('#/maintenance')
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(400)
  // A report already exists for this visit, so the export prompts first — the
  // download only fires once a revision is chosen.
  await page.getByRole('button', { name: /^Export report$/ }).click()
  await page.waitForTimeout(500)
  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /Save as Revision/ }).click(),
  ])
  const out2 = `${DIR}/settings-report-nologo.xlsx`
  await dl2.saveAs(out2)
  wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(out2)
  ws = wb.worksheets[0]
  const rows2 = []
  ws.eachRow({ includeEmpty: true }, r => rows2.push(String(r.getCell(1).value ?? '')))
  text = rows2.join('\n')
  log('report without a logo still generates', /Northpoint Audio Visual/.test(text) && ws.getImages().length === 0)

  // ── Account panel ────────────────────────────────────────────────────────
  //
  // These suites run on localStorage with no session, so the signed-in card
  // cannot be rendered here — what IS worth pinning is that its absence is
  // graceful. AccountPanel reads user.email, so a missing null guard would
  // throw and take the whole Settings page down with it. That is the
  // regression this catches; the card itself needs a real session to see.
  await goto('#/settings')
  const noSession = await body()
  log('Settings still renders with no session', /Company/.test(noSession) && /Test lists/.test(noSession))
  log('no Account section without a session', !/Signed in as/.test(noSession))
  log('and so no unreachable Sign out button', (await page.getByRole('button', { name: 'Sign out' }).count()) === 0)

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/settings-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
