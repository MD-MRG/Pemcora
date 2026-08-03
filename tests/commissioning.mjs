import { chromium } from 'playwright-core'
import ExcelJS from 'exceljs'

const DIR = process.argv[2] ?? '.'
const BASE = 'http://localhost:5173/'

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }) } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const SEED = [
  { id: 'c1', name: 'Equinix', locations: [
    { id: 'l1', address: '8 Grand Avenue', suburb: 'Rosehill', city: 'Sydney', state: 'NSW', postcode: '2142',
      floors: [{ id: 'f1', label: 'Ground', rooms: [
        { id: 'r1', name: 'Reception', planNumber: 'G-01' },
        { id: 'r2', name: 'Boardroom', planNumber: 'G-02' },
      ]}],
      // A visit stored before Commissioning existed: no `kind` at all.
      visits: [{ id: 'v-legacy', startedAt: '2026-01-05T09:00:00.000Z', completedAt: '2026-01-05T14:00:00.000Z',
                 rooms: {}, exports: [], exportPreference: null }] },
  ]},
]

const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await ctx.newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
const visits = async () => (await store())[0].locations[0].visits
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')

async function openLocation(route) {
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(120)
  await page.goto(BASE + route, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(400)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(s => {
    localStorage.setItem('fc.clients', JSON.stringify(s))
    localStorage.removeItem('fc.templates')
  }, SEED)

  // 8 · a kind-less legacy visit belongs to PM
  await openLocation('#/maintenance')
  log('legacy visit (no kind) still shows under PM', /Last visit completed/.test(await body()))

  // 4a · commissioning must not see PM's history
  await openLocation('#/commissioning')
  let t = await body()
  log('commissioning does not see the PM visit', /No commissioning recorded for this location/.test(t))

  // 3 · naming
  log('page title is Commissioning', /Commissioning — Equinix/.test(t))
  log('offers Start commissioning', (await page.getByRole('button', { name: /^Start commissioning$/ }).count()) === 1)

  await page.getByRole('button', { name: /^Start commissioning$/ }).click()
  await page.waitForTimeout(450)
  log('reads "Commissioning in progress"', /Commissioning in progress/.test(await body()))

  // 1 · the commissioning template
  await page.getByRole('button', { name: /Reception/ }).click()
  await page.waitForTimeout(500)
  const mainCount = await page.locator('main section').first().locator('button[aria-pressed]').count()
  log('main list has 25 commissioning tests', mainCount === 25 * 3, `${mainCount / 3} tests`)
  t = await body()
  log('carries commissioning-only tests',
    /Test network connectivity to all AV devices/.test(t) && /Booking panel signed in with calendar displayed/.test(t))
  const rc = page.locator('main section').filter({ hasText: 'Room controls' }).first()
  await rc.locator('input[type=checkbox]').check()
  await page.waitForTimeout(400)
  const rcCount = await rc.locator('button[aria-pressed]').count()
  log('Room controls has 9 tests', rcCount === 9 * 3, `${rcCount / 3} tests`)
  log('includes Ceiling Mic LED Mute Sync', /Ceiling Mic LED Mute Sync/.test(await body()))

  await page.getByRole('button', { name: 'Correct Time and Date: PASS' }).click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: /Mark room complete/ }).click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^List$/ }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${DIR}/commissioning.png` })

  // 4b + 5 · separation and concurrency
  let v = await visits()
  log('commissioning visit tagged', v.some(x => x.kind === 'commissioning'), v.map(x => x.kind ?? '(none)').join(', '))

  await openLocation('#/maintenance')
  t = await body()
  log('PM does not see the open commissioning', !/in progress/.test(t) && /Last visit completed/.test(t))
  await page.getByRole('button', { name: /^Start new visit$/ }).click()
  await page.waitForTimeout(450)
  log('PM opens its own visit alongside the commissioning', /Preventative Maintenance in progress/.test(await body()))
  v = await visits()
  const open = v.filter(x => !x.completedAt)
  log('both workflows open at once', open.length === 2 &&
    open.some(x => x.kind === 'commissioning') && open.some(x => (x.kind ?? 'maintenance') === 'maintenance'),
    open.map(x => x.kind ?? 'maintenance').join(' + '))

  // 2 · PM template unchanged
  await page.getByRole('button', { name: /Reception/ }).click()
  await page.waitForTimeout(500)
  const pmCount = await page.locator('main section').first().locator('button[aria-pressed]').count()
  log('PM still renders 19 tests', pmCount === 19 * 3, `${pmCount / 3} tests`)

  // 6 · templates are independent copies
  const tmpl = await page.evaluate(() => JSON.parse(localStorage.getItem('fc.templates')))
  log('two independent templates stored',
    tmpl.maintenance.tests.length === 19 && tmpl.commissioning.tests.length === 25,
    `pm=${tmpl.maintenance.tests.length} comm=${tmpl.commissioning.tests.length}`)
  log('template test ids do not overlap',
    !tmpl.maintenance.tests.some(a => tmpl.commissioning.tests.some(b => b.id === a.id)))

  // 7 · export naming
  await openLocation('#/commissioning')
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /^Export report$/ }).click(),
  ])
  log('filename starts with Commissioning', /^Commissioning Equinix/.test(dl.suggestedFilename()), dl.suggestedFilename())
  const out = `${DIR}/commissioning-report.xlsx`
  await dl.saveAs(out)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(out)
  const ws = wb.worksheets[0]
  const rows = []
  ws.eachRow({ includeEmpty: true }, r => rows.push(String(r.getCell(1).value ?? '') + '|' + String(r.getCell(2).value ?? '')))
  const text = rows.join('\n')
  log('report heading is Commissioning', rows[0].startsWith('Commissioning'), rows[0])
  log('report carries the commissioning tests', /Test network connectivity to all AV devices/.test(text))
  log('exporting closed only the commissioning visit', (await visits()).filter(x => !x.completedAt).length === 1)

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/commissioning-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
