import { chromium } from 'playwright-core'
import ExcelJS from 'exceljs'

const DIR = process.argv[2] ?? '.'
const BASE = 'http://localhost:5173/'
const URL = BASE + '#/maintenance'

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
      ]}], visits: [] },
  ]},
]

const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const page = await ctx.newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
const visitOf = async () => (await store())[0].locations[0].visits[0]
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')

async function openLocation() {
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(120)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(350)
}
const setResult = async (label, value) => {
  await page.getByRole('button', { name: `${label}: ${value}` }).click()
  await page.waitForTimeout(180)
}
async function exportNow() {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /^Export report$/ }).click(),
  ])
  return dl
}
async function readSheet(dl, name) {
  const out = `${DIR}/${name}`
  await dl.saveAs(out)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(out)
  const ws = wb.worksheets[0]
  const cells = []
  ws.eachRow({ includeEmpty: true }, row => {
    const a = row.getCell(1), b = row.getCell(2)
    const txt = c => (typeof c.value === 'object' && c.value?.richText
      ? c.value.richText.map(x => x.text).join('')
      : String(c.value ?? ''))
    cells.push([txt(a), txt(b), a.font, b.font, a.fill])
  })
  return { ws, cells, text: cells.map(c => c[0] + '|' + c[1]).join('\n') }
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(s => {
    localStorage.setItem('fc.clients', JSON.stringify(s))
    localStorage.removeItem('fc.templates')
  }, SEED)

  // set up a visit with real results
  await openLocation()
  await page.getByRole('button', { name: /^Start PM$/ }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Reception/ }).click()
  await page.waitForTimeout(450)
  await setResult('Correct Time and Date', 'PASS')
  await setResult('Room Wake On Touch', 'FAIL')
  await setResult('Test call performed', 'N/A')
  // leave 'Audio In room' blank deliberately
  await page.locator('textarea').first().fill('Panel rebooted on site')
  await page.locator('textarea').first().blur()
  await page.waitForTimeout(300)
  // enable a section, fail one, then hide it again
  const rc = page.locator('main section').filter({ hasText: 'Room controls' }).first()
  await rc.locator('input[type=checkbox]').check()
  await page.waitForTimeout(300)
  await setResult('Mic Mute', 'FAIL')
  await rc.locator('input[type=checkbox]').uncheck()
  await page.waitForTimeout(400)
  const commentBox = page.locator('textarea').last()
  await commentBox.fill('Rack tidy required')
  await commentBox.blur()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^List$/ }).click()
  await page.waitForTimeout(400)

  // 1 · first export — no prompt, closes the visit
  let dl = await exportNow()
  log('first export downloads without a prompt', dl.suggestedFilename().endsWith('.xlsx'), dl.suggestedFilename())
  log('filename has no revision suffix', !/Rev/.test(dl.suggestedFilename()), dl.suggestedFilename())
  let v = await visitOf()
  log('export recorded as revision 1', v.exports.length === 1 && v.exports[0].revision === 1)
  log('exporting closed the visit', !!v.completedAt)
  log('card offers Start new visit', (await page.getByRole('button', { name: /^Start new visit$/ }).count()) === 1)

  // 2 · content
  const r1 = await readSheet(dl, 'rev1.xlsx')
  log('report names client and address', /Client\|Equinix/.test(r1.text) && /8 Grand Avenue/.test(r1.text))
  log('rooms present', /Room 1: Reception/.test(r1.text) && /Room 2: Boardroom/.test(r1.text))
  log('results written', /Correct Time and Date\|PASS/.test(r1.text) && /Room Wake On Touch\|FAIL/.test(r1.text) && /Test call performed\|N\/A/.test(r1.text))
  log('blank exports empty, not N/A', /Audio In room\|$/m.test(r1.text))
  log('troubleshooting note included', /Panel rebooted on site/.test(r1.text))
  log('comments included', /Rack tidy required/.test(r1.text))
  log('hidden section excluded from the report', !/Mic Mute/.test(r1.text) && !/Room controls/.test(r1.text))
  log('untested room marked as such', /Not tested during this visit/.test(r1.text))
  log('no Revision line on the first report', !/Revision \d/.test(r1.text))
  log('styling: bold labels + navy room banner',
    r1.cells.some(c => c[0] === 'Client' && c[2]?.bold) &&
    r1.cells.some(c => String(c[4]?.fgColor?.argb ?? '').toUpperCase().includes('1B3A5C')))

  // 3 · second export prompts
  await page.getByRole('button', { name: /^Export report$/ }).click()
  await page.waitForTimeout(400)
  log('second export asks', /A report already exists for this visit/.test(await body()))
  log('offers Revision 2', (await page.getByRole('button', { name: /Save as Revision 2/ }).count()) === 1)
  await page.screenshot({ path: `${DIR}/pm3-dialog.png` })

  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /Save as Revision 2/ }).click(),
  ])
  log('revision 2 filename carries Rev 2', /Rev 2\.xlsx$/.test(dl2.suggestedFilename()), dl2.suggestedFilename())
  const r2 = await readSheet(dl2, 'rev2.xlsx')
  log('revision 2 stamped in the report header', /Revision 2/.test(r2.text))
  v = await visitOf()
  log('two revisions recorded', v.exports.length === 2 && v.exports.map(e => e.revision).join() === '1,2')

  // 4 · replace keeps the revision number
  await page.getByRole('button', { name: /^Export report$/ }).click()
  await page.waitForTimeout(400)
  const [dl3] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /Replace previous report/ }).click(),
  ])
  log('replace reuses the Rev 2 filename', /Rev 2\.xlsx$/.test(dl3.suggestedFilename()), dl3.suggestedFilename())
  v = await visitOf()
  log('replace does not add a revision', v.exports.length === 2, `${v.exports.length} exports`)

  // 5 · remember the choice
  await page.getByRole('button', { name: /^Export report$/ }).click()
  await page.waitForTimeout(400)
  await page.getByRole('checkbox').check()
  const [dl4] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /Save as Revision 3/ }).click(),
  ])
  log('revision 3 produced', /Rev 3\.xlsx$/.test(dl4.suggestedFilename()), dl4.suggestedFilename())
  v = await visitOf()
  log('preference remembered', v.exportPreference === 'revision', String(v.exportPreference))

  const [dl5] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: /^Export report$/ }).click(),
  ])
  log('remembered choice skips the prompt', /Rev 4\.xlsx$/.test(dl5.suggestedFilename()), dl5.suggestedFilename())

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/pm3-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
