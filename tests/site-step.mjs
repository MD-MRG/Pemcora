/**
 * Step C1e: the whole-site step, its sections repeated for each item, and coverage.
 *
 * Runs the rules in Node first, then the Queensland smoke alarm inspection in a
 * browser in test mode, as a technician walks a house: alarms added as they're
 * tested, a bedroom left without one, a failed alarm that has to be replaced.
 *
 *   node tests/site-step.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - the visit's room list opens the whole-site step, and shows its fails
 *   - each item at the site gets its own answers, under its id, and "Add item" adds
 *     one there and then, pinned to a room or not
 *   - a room its pack says needs an item, and has none, is named
 *   - a failed smoke alarm test asks why, and one where the alarm itself is at
 *     fault says it has to be replaced
 *   - an AV visit looks as it always has
 */
import { chromium } from 'playwright-core'
import ExcelJS from 'exceljs'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// ── The rules ───────────────────────────────────────────────────────────────
const { gapLines, isSiteOnly, itemsFor, siteSectionsOf } = await import('../src/lib/siteStep.js')

const LIST = {
  tests: [],
  sections: [
    { id: 'si', label: 'Each smoke alarm', scope: 'item', assetType: 'smoke_alarm', tests: [] },
    { id: 'ss', label: 'Every storey', scope: 'site', tests: [] },
  ],
  coverage: [{ roomTypes: ['bedroom'], assetType: 'smoke_alarm', min: 1 }],
}
const ROOMS = [
  { id: 'b1', name: 'Bedroom 1', roomType: 'bedroom' },
  { id: 'b2', name: 'Bedroom 2', roomType: 'bedroom' },
  { id: 'h', name: 'Hallway', roomType: 'hallway' },
]
const alarm = (id, roomId, extra = {}) => ({ id, assetType: 'smoke_alarm', roomId, ...extra })

log('a list\'s whole-site sections are its site and per-item ones', siteSectionsOf(LIST).map(s => s.id).join() === 'si,ss')
log('a list with nothing room by room is whole-site only', isSiteOnly(LIST))
log('one with a room section is not', !isSiteOnly({ ...LIST, sections: [...LIST.sections, { id: 'r', label: 'Room', tests: [] }] }))
log('nor is an AV list', !isSiteOnly({ tests: [{ id: 't' }], sections: [{ id: 's', label: 'Room controls', tests: [] }] }))
log('each bedroom without an alarm is named',
  gapLines(LIST, ROOMS, [alarm('a', 'h')]).join(' | ') === 'Bedroom 1 has no smoke alarm | Bedroom 2 has no smoke alarm')
log('an alarm pinned to a bedroom covers it', gapLines(LIST, ROOMS, [alarm('a', 'b1')]).join() === 'Bedroom 2 has no smoke alarm')
log('a removed alarm doesn\'t', gapLines(LIST, ROOMS, [alarm('a', 'b1', { removedAt: '2026-01-01' })]).length === 2)
log('an item section covers the items of its type, and a removed one only if it was answered',
  itemsFor(LIST.sections[0], [alarm('a'), alarm('gone', null, { removedAt: 'x' }), alarm('old', null, { removedAt: 'x' }), { id: 'r', assetType: 'rcd' }], { old: {} })
    .map(a => a.id).join() === 'a,old')

// ── The screens ─────────────────────────────────────────────────────────────
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
        floors: [
          {
            id: 'f1',
            label: 'Upstairs',
            rooms: [
              { id: 'b1', name: 'Bedroom 1', planNumber: '', roomType: 'bedroom' },
              { id: 'b2', name: 'Bedroom 2', planNumber: '', roomType: 'bedroom' },
              { id: 'h', name: 'Hallway', planNumber: '', roomType: 'hallway' },
            ],
          },
        ],
        visits: [],
      },
    ],
  },
]

const WORKS = 'Works when tested (replaced immediately if not)'
const CLEANED = 'Cleaned'

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  const main = () => page.textContent('main')
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients'))[0].locations[0])
  const openSite = async kindPath => {
    await page.goto(BASE + kindPath, { waitUntil: 'networkidle' })
    await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
    await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(seed => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
    localStorage.removeItem('fc.templates')
  }, SEED)

  // The visit's room list.
  await openSite('#/qld-smoke-alarm')
  await page.getByRole('button', { name: 'Start smoke alarm inspection' }).click()
  let text = await main()
  log('the room list opens with the whole-site step', /Whole site/.test(text) && /Each smoke alarm · Every storey/.test(text))
  log('and names each bedroom with no alarm', /Bedroom 1 has no smoke alarm/.test(text) && /Bedroom 2 has no smoke alarm/.test(text) && !/Hallway has no/.test(text))
  log('it counts no rooms, which have nothing to do', /whole site not started/.test(text) && !/rooms complete/.test(text))
  log('and its rooms show no status', !/Not started/.test(await page.getByRole('button', { name: /^Bedroom 1/ }).textContent()))
  await page.screenshot({ path: `${DIR}/site-visit.png` })

  await page.getByRole('button', { name: 'Continue' }).click()
  text = await main()
  log('with nothing to do room by room, Continue opens the whole-site step', /Each smoke alarm/.test(text) && /Every storey/.test(text) && /Back to the rooms/.test(text))
  log('which says when there are no alarms yet', /No smoke alarms recorded at this site yet/.test(text))

  // Alarms added as they're tested.
  const add = async (name, room) => {
    await page.getByRole('button', { name: '+ Add smoke alarm' }).click()
    await page.getByLabel('New smoke alarm name').fill(name)
    if (room) await page.getByLabel('New smoke alarm room').selectOption({ label: `${room} · Upstairs` })
    await page.getByRole('button', { name: 'Add smoke alarm', exact: true }).click()
  }
  await add('Bedroom 1 alarm', 'Bedroom 1')
  let loc = await stored()
  const first = loc.assets?.[0]
  log('"Add smoke alarm" adds it at the site, pinned to its room', first?.assetType === 'smoke_alarm' && first.roomId === 'b1' && first.label === 'Bedroom 1 alarm', JSON.stringify(loc.assets))
  text = await main()
  log('it gets its own tests there and then', (await page.getByRole('group', { name: 'Bedroom 1 alarm' }).count()) === 1)
  log('and the bedroom it covers drops off the list', !/Bedroom 1 has no smoke alarm/.test(text) && /Bedroom 2 has no smoke alarm/.test(text))
  await add('Landing alarm')

  const alarmGroup = name => page.getByRole('group', { name, exact: true })
  await alarmGroup('Bedroom 1 alarm').getByRole('button', { name: `${WORKS}: FAIL`, exact: true }).click()
  await alarmGroup('Landing alarm').getByRole('button', { name: `${WORKS}: PASS`, exact: true }).click()
  await alarmGroup('Landing alarm').getByRole('button', { name: `${CLEANED}: FAIL`, exact: true }).click()
  await page.getByRole('button', { name: 'An alarm in every bedroom: PASS', exact: true }).click()

  loc = await stored()
  const visit = loc.visits[0]
  const template = visit.siteResults?.template
  const each = template?.sections.find(s => s.label === 'Each smoke alarm')
  const storey = template?.sections.find(s => s.label === 'Every storey')
  const testId = (section, label) => section?.tests.find(t => t.label === label)?.id
  const landing = loc.assets.find(a => a.label === 'Landing alarm')
  log('each alarm\'s answers are kept under its own id',
    visit.siteResults.results[each.id]?.[first.id]?.[testId(each, WORKS)] === 'FAIL' &&
      visit.siteResults.results[each.id]?.[landing.id]?.[testId(each, WORKS)] === 'PASS',
    JSON.stringify(visit.siteResults.results))
  log('and the whole-site answers under the section', visit.siteResults.results[storey.id]?.[testId(storey, 'An alarm in every bedroom')] === 'PASS')

  // The note boxes.
  const worksNote = page.getByRole('textbox', { name: `Bedroom 1 alarm — ${WORKS}`, exact: true })
  const cleanedNote = page.getByRole('textbox', { name: `Landing alarm — ${CLEANED}`, exact: true })
  log('a failed alarm test asks why it failed', (await worksNote.getAttribute('placeholder')) === 'Why did it fail?')
  text = await main()
  log('one where the alarm is at fault says it has to be replaced', (text.match(/Has to be replaced/g) ?? []).length === 1)
  log('and one where it isn\'t takes an ordinary note', (await cleanedNote.count()) === 1 && (await cleanedNote.getAttribute('placeholder')) === 'Why did it fail?')
  log('a smoke alarm check offers no suggested wording', (await page.getByText('Suggested wording').count()) === 0)
  await worksNote.fill('No sound when tested')
  loc = await stored()
  log('the note is kept under the alarm and the test', loc.visits[0].siteResults.troubleshooting[`${first.id}:${testId(each, WORKS)}`] === 'No sound when tested')
  await page.evaluate(() => document.querySelector('main .overflow-auto')?.scrollTo(0, 0))
  await page.screenshot({ path: `${DIR}/site-step.png` })

  // Back on the room list, the fails show.
  await page.getByRole('button', { name: 'Back to the rooms' }).click()
  const siteRow = page.getByRole('button', { name: /^Whole site/ })
  log('the whole-site row shows its fails', /2 FAILs/.test(await siteRow.textContent()), await siteRow.textContent())

  // On Home too, with the one with no note flagged.
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  text = await page.textContent('main')
  log('Home counts them on the open visit', /2 FAILs/.test(text))
  log('and flags the one with no note', /FAILS WITHOUT NOTES/i.test(text) && /1 FAIL with nothing/.test(text), text.replace(/\s+/g, ' ').slice(0, 400))

  // A reload keeps it all.
  await page.reload({ waitUntil: 'networkidle' })
  await openSite('#/qld-smoke-alarm')
  await page.getByRole('button', { name: /^Whole site/ }).click()
  log('a reload keeps the alarms and their answers',
    (await alarmGroup('Landing alarm').getByRole('button', { name: `${CLEANED}: FAIL`, exact: true }).getAttribute('aria-pressed')) === 'true')

  // The report covers each alarm.
  // It's signed off on the way (C1f, tests/signoff.mjs).
  await page.getByRole('button', { name: 'Back to the rooms' }).click()
  await page.getByRole('button', { name: 'Export report' }).click()
  const signing = page.getByRole('dialog')
  await signing.getByLabel('Non-compliant').check()
  await signing.getByLabel('Name').fill('Sam')
  await signing.getByLabel('Licence or registration number').fill('QLD-1')
  const pad = await signing.getByRole('img', { name: /Signature/ }).boundingBox()
  await page.mouse.move(pad.x + 40, pad.y + 60)
  await page.mouse.down()
  await page.mouse.move(pad.x + 200, pad.y + 90, { steps: 8 })
  await page.mouse.up()
  const download = page.waitForEvent('download', { timeout: 15000 })
  await signing.getByRole('button', { name: 'Sign and finish' }).click()
  const file = await download
  log('the report exports', /\.xlsx$/.test(file.suggestedFilename()), file.suggestedFilename())
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(await file.path())
  const cells = []
  wb.worksheets[0].eachRow(row => cells.push(row.values.filter(v => v != null).map(String).join(' | ')))
  log('naming each alarm', cells.some(c => c.includes('Bedroom 1 alarm')) && cells.some(c => c.includes('Landing alarm')),
    cells.filter(c => /alarm/i.test(c)).slice(0, 4).join(' / '))
  log('finishing the visit with it', !!(await stored()).visits[0].completedAt)

  // Finished: read-only.
  await page.getByRole('button', { name: /^Whole site/ }).click()
  text = await main()
  log('a finished visit\'s whole-site step is read-only', /This visit is finished/.test(text) && (await page.getByRole('button', { name: '+ Add smoke alarm' }).count()) === 0)
  log('its answers can\'t be changed', await alarmGroup('Landing alarm').getByRole('button', { name: `${CLEANED}: PASS`, exact: true }).isDisabled())

  // An AV visit looks as it always has.
  await openSite('#/maintenance')
  text = await main()
  log('an AV visit has no whole-site step', !/Whole site/.test(text))
  log('and names no missing alarms', !/has no smoke alarm/.test(text))
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
