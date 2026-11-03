/**
 * Steps C2 and C2b: the equipment panel on a site's page, and replacing an item.
 *
 * Runs the rules in Node first, then a Queensland smoke alarm site in a browser
 * in test mode: alarms added, edited and listed with their expiry, before any
 * visit has started.
 *
 *   node tests/equipment.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - the panel shows on the page of a check that tests items one by one, and
 *     not on an AV page
 *   - each type's own fields are kept in the item's attributes, and a field this
 *     form doesn't know about survives an edit
 *   - a smoke alarm's manufacture date fills in its expiry, ten years on, and a
 *     typed expiry is left alone
 *   - an expired alarm, and one expiring within three months, say so
 *   - a removed alarm stays on record under "Removed"
 *   - an alarm added in the panel is the one the whole-site step tests
 *   - replacing an alarm removes it and adds the new one in its place, at the
 *     same moment, from the panel or from a failed alarm's note; the old one's
 *     answers stay with it
 *   - removing one keeps it on record
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// ── The rules ───────────────────────────────────────────────────────────────
const { addMonths, expiryFrom, expiryState, fieldText, itemName, itemSummary, localDate, panelTypes } = await import(
  '../src/lib/equipment.js'
)
const { assetFields } = await import('../src/data/packs/shared/assetTypes.js')
const { workflow } = await import('../src/data/packs/index.js')

const qldList = workflow('qld_smoke_alarm').seed
const avList = workflow('maintenance').seed
log('the smoke alarm inspection tests smoke alarms one by one', panelTypes(qldList).join() === 'smoke_alarm')
log('an AV list tests no items', avList.sections.length > 0 && panelTypes(avList).length === 0)
log('each type is listed once', panelTypes({ sections: [
  { scope: 'item', assetType: 'rcd' }, { scope: 'item', assetType: 'smoke_alarm' }, { scope: 'item', assetType: 'rcd' }, { scope: 'site' },
] }).join() === 'rcd,smoke_alarm')

log('a smoke alarm expires ten years after it was made', expiryFrom('2017-05-10', 'smoke_alarm') === '2027-05-10')
log('one made on 29 February expires on the 28th', expiryFrom('2016-02-29', 'smoke_alarm') === '2026-02-28')
log('an RCD doesn\'t expire', expiryFrom('2017-05-10', 'rcd') === null)
log('nor does an alarm with no manufacture date', expiryFrom('', 'smoke_alarm') === null && expiryFrom(undefined, 'smoke_alarm') === null)
log('a month on from the 31st is the end of the next month', addMonths('2026-01-31', 1) === '2026-02-28' && addMonths('2026-11-15', 3) === '2027-02-15')

const today = '2026-11-03'
log('an alarm expiring today has expired', expiryState({ expiresOn: today }, today) === 'expired')
log('one expiring within three months is flagged', expiryState({ expiresOn: '2027-02-03' }, today) === 'soon')
log('one expiring later isn\'t', expiryState({ expiresOn: '2027-02-04' }, today) === null)
log('nor is a removed one, or one with no date', expiryState({ expiresOn: '2020-01-01', removedAt: 'x' }, today) === null && expiryState({}, today) === null)
log('today is the device\'s own date', /^\d{4}-\d{2}-\d{2}$/.test(localDate()))

const [sensor, , interconnected] = assetFields('smoke_alarm')
log('a choice reads as its words', fieldText(sensor, 'photoelectric') === 'Photoelectric')
log('a yes/no as Yes or No, and blank when not recorded',
  fieldText(interconnected, true) === 'Yes' && fieldText(interconnected, false) === 'No' && fieldText(interconnected, undefined) === '')
log('an item is summed up by its choices, make and model',
  itemSummary({ assetType: 'smoke_alarm', attributes: { sensor: 'photoelectric', power: 'mains', interconnected: true }, make: 'Clipsal', model: '755PSMA' }) ===
    'Photoelectric · 240 V hard-wired · Clipsal 755PSMA')
log('an item with no name is named by its type and place', itemName({ assetType: 'smoke_alarm', label: '' }, 1) === 'Smoke alarm 2')

// ── The report's equipment (C2d) ────────────────────────────────────────────
{
  // The list as a visit holds it, shaped by the template store, which keeps its
  // edits in localStorage.
  const store = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  })
  const { getTemplate } = await import('../src/lib/templateStore.js')
  const { buildReportSnapshot } = await import('../src/lib/reportSnapshot.js')
  const { buildWorkbook } = await import('../src/lib/report.js')
  const qldList = getTemplate('qld_smoke_alarm')
  delete globalThis.localStorage
  const each = qldList.sections.find(s => s.assetType === 'smoke_alarm')
  const works = each.tests.find(t => t.onFail === 'replace')
  const item = (id, label, extra = {}) => ({
    id, assetType: 'smoke_alarm', roomId: null, label, make: '', model: '', serial: '', attributes: {},
    installedOn: null, expiresOn: null, removedAt: null, createdAt: '2020-01-01T00:00:00.000Z', ...extra,
  })
  const assets = [
    item('old', 'Bedroom 1 alarm', { roomId: 'b1', removedAt: '2026-11-03T02:00:00.000Z', attributes: { sensor: 'ionisation' } }),
    item('new', 'Bedroom 1 alarm', {
      roomId: 'b1', createdAt: '2026-11-03T02:00:00.000Z', make: 'Clipsal', model: '755PSMA', expiresOn: '2036-01-15',
      attributes: { sensor: 'photoelectric', power: 'mains', replaces: 'old' },
    }),
    item('hall', 'Hall alarm', { expiresOn: '2026-10-01' }),
    item('laundry', 'Laundry alarm', { removedAt: '2025-06-01T00:00:00.000Z' }),
    item('garage', 'Garage alarm', { removedAt: '2026-11-03T03:00:00.000Z' }),
    item('later', 'Added since', { createdAt: '2026-11-10T00:00:00.000Z' }),
    { ...item('rcd', 'RCD 1'), assetType: 'rcd' },
  ]
  const visit = {
    technician: 'Sam', startedAt: '2026-11-03T00:00:00.000Z', completedAt: '2026-11-03T05:00:00.000Z', rooms: {},
    siteResults: { template: qldList, results: { [each.id]: { old: { [works.id]: 'FAIL' } } }, troubleshooting: {} },
  }
  const rooms = [{ id: 'b1', name: 'Bedroom 1', floorLabel: 'Upstairs' }]
  const snap = buildReportSnapshot({ visit, rooms, assets })
  const eq = id => snap.equipment.find(e => e.id === id)
  log('the report lists the alarms standing when the visit finished, and those taken out during it',
    snap.equipment.map(e => e.id).join() === 'old,new,hall,garage', snap.equipment.map(e => e.id).join())
  log('not one gone before it, one added since, or a type the list doesn\'t test',
    !eq('laundry') && !eq('later') && !eq('rcd'))
  log('each with when it went in, and when it came out if it did',
    eq('new').createdAt === '2026-11-03T02:00:00.000Z' && eq('new').removedAt === null && eq('old').removedAt === '2026-11-03T02:00:00.000Z')
  log('a replaced alarm says so, and the new one what it replaced',
    eq('old').status === 'replaced' && eq('old').replacedBy === 'Bedroom 1 alarm' && eq('new').status === 'in place' && eq('new').replaces === 'Bedroom 1 alarm')
  log('one taken out with nothing in its place is removed', eq('garage').status === 'removed' && eq('garage').replacedBy === null)
  log('its own fields in words, those recorded',
    JSON.stringify(eq('new').details) === JSON.stringify([['Sensor', 'Photoelectric'], ['Power', '240 V hard-wired']]), JSON.stringify(eq('new').details))
  log('the whole-site step\'s old alarm is named as replaced',
    snap.site.sections[0].items.map(i => i.label).join() === 'Bedroom 1 alarm (replaced),Bedroom 1 alarm,Hall alarm',
    snap.site.sections[0].items.map(i => i.label).join())
  const open = buildReportSnapshot({ visit: { ...visit, completedAt: null }, rooms, assets })
  log('a visit still open lists what is there now, and what came out since it started',
    open.equipment.map(e => e.id).join() === 'old,new,hall,garage,later', open.equipment.map(e => e.id).join())
  log('an AV visit lists none', buildReportSnapshot({ visit: { rooms: {} }, rooms, assets }).equipment.length === 0)

  const rowsOf = async wb => {
    const out = []
    wb.worksheets[0].eachRow(r => out.push(r))
    return out
  }
  // A row merged across both columns reads its text once.
  const text = r => {
    const cells = r.values.filter(v => v != null).map(String)
    return cells.length === 2 && cells[0] === cells[1] && r.getCell(1).isMerged ? cells[0] : cells.join('|')
  }
  const wb = await buildWorkbook({ client: { name: 'Rental Co' }, location: { address: '10 Smith St' }, visit, rooms, revision: 1, reportTitle: 'Smoke Alarm Compliance Inspection', assets, sheetName: 'Report' })
  const rows = await rowsOf(wb)
  const lines = rows.map(text)
  const at = line => lines.indexOf(line)
  log('the Excel report has an Equipment part after the whole site',
    at('Equipment') > at('Whole site') && at('Whole site') > 0 && at('Smoke alarms') > at('Equipment'), lines.slice(-30).join(' / '))
  log('each alarm under its name and room, the replaced one marked',
    at('Bedroom 1 alarm (Bedroom 1) (replaced)') > 0 && at('Replaced|2026-11-03') > at('Bedroom 1 alarm (Bedroom 1) (replaced)') &&
      // The new one's heading is in the whole-site results too; this is the last.
      lines.lastIndexOf('Bedroom 1 alarm (Bedroom 1)') > at('Replaced|2026-11-03'))
  log('with its details, make and model, and what it replaced',
    lines.includes('Sensor|Photoelectric') && lines.includes('Power|240 V hard-wired') && lines.includes('Make and model|Clipsal 755PSMA') &&
      lines.includes('Expires|2036-01-15') && lines.includes('Put in|2026-11-03, replacing Bedroom 1 alarm'))
  const expired = rows.find(r => text(r) === 'Expires|2026-10-01 (expired)')
  log('an alarm expired by the day of the visit says so, in the fail colour', expired?.getCell(2).font?.color?.argb === 'FFC22E1C')
  log('one taken out says when', lines.includes('Garage alarm (removed)') && lines.includes('Removed|2026-11-03'))
  log('nothing is printed that wasn\'t recorded', !lines.some(l => /^(Serial number|Installed)\|/.test(l)))
  const av = await rowsOf(await buildWorkbook({ client: { name: 'AV Co' }, location: {}, visit: { rooms: {} }, rooms, revision: 1, assets }))
  log('an AV report has no Equipment part', !av.map(text).includes('Equipment'))
}

// ── The screens ─────────────────────────────────────────────────────────────
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const soon = addMonths(localDate(), 1)
const alarm = (id, label, extra = {}) => ({
  id, assetType: 'smoke_alarm', roomId: null, label, make: '', model: '', serial: '',
  attributes: {}, installedOn: null, expiresOn: null, removedAt: null, createdAt: '2025-01-01T00:00:00.000Z', ...extra,
})
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
              { id: 'h', name: 'Hallway', planNumber: '', roomType: 'hallway' },
            ],
          },
        ],
        assets: [
          alarm('old', 'Kitchen alarm', { expiresOn: '2020-06-01', attributes: { sensor: 'ionisation', fitted_by: 'previous owner' } }),
          alarm('soon', 'Hallway alarm', { roomId: 'h', expiresOn: soon }),
          alarm('gone', 'Laundry alarm', { removedAt: '2026-02-01T00:00:00.000Z' }),
        ],
        visits: [],
      },
    ],
  },
]

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients'))[0].locations[0])
  const openSite = async path => {
    await page.goto(BASE + path, { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
    await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  }
  const panel = () => page.getByRole('region', { name: 'Equipment' })
  const row = name => panel().getByRole('button', { name: `Edit ${name}`, exact: true })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(seed => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
    localStorage.removeItem('fc.templates')
  }, SEED)

  await openSite('#/qld-smoke-alarm')
  log('the site\'s page has an equipment panel before any visit starts', (await panel().count()) === 1)
  let text = await panel().textContent()
  log('listing the alarms still there', /Smoke alarms \(2\)/.test(text) && /Kitchen alarm/.test(text) && /Hallway alarm/.test(text) && !/Laundry alarm/.test(text), text)
  log('an expired alarm says so', /^Kitchen alarm.*Expired /.test(await row('Kitchen alarm').textContent()))
  log('and one expiring within three months says when',
    /Expires /.test(await row('Hallway alarm').textContent()) && (await row('Hallway alarm').locator('.bg-amber-100').count()) === 1)
  log('with its room and what it is', /Hallway/.test(await row('Hallway alarm').textContent()) && /Ionisation/.test(await row('Kitchen alarm').textContent()))
  await panel().getByRole('button', { name: 'Removed smoke alarms (1)' }).click()
  log('a removed alarm stays on record under Removed', /Laundry alarm · removed/.test(await panel().textContent()))

  // Adding one.
  await panel().getByRole('button', { name: '+ Add smoke alarm' }).click()
  const form = () => panel().getByRole('form', { name: 'New smoke alarm' })
  await form().getByLabel('Name').fill('Bedroom 1 alarm')
  await form().getByLabel('Room').selectOption({ label: 'Bedroom 1 · Upstairs' })
  await form().getByLabel('Sensor').selectOption({ label: 'Photoelectric' })
  await form().getByLabel('Power').selectOption({ label: '240 V hard-wired' })
  await form().getByLabel('Interconnected').selectOption({ label: 'Yes' })
  await form().getByLabel('Marked AS 3786-2014').selectOption({ label: 'No' })
  await form().getByLabel('Make').fill('Clipsal')
  await form().getByLabel('Manufactured').fill('2019-04-12')
  log('the manufacture date fills in the expiry', (await form().getByLabel('Expires').inputValue()) === '2029-04-12')
  await form().getByLabel('Manufactured').fill('2019-08-01')
  log('and moves it when the date is corrected', (await form().getByLabel('Expires').inputValue()) === '2029-08-01')
  await page.screenshot({ path: `${DIR}/equipment-add.png` })
  await form().getByRole('button', { name: 'Add smoke alarm' }).click()

  let loc = await stored()
  const added = loc.assets.find(a => a.label === 'Bedroom 1 alarm')
  log('the alarm is added at the site, pinned to its room', added?.roomId === 'b1' && added.assetType === 'smoke_alarm' && !added.removedAt)
  log('with its type\'s fields in its attributes',
    JSON.stringify(added?.attributes) === JSON.stringify({ sensor: 'photoelectric', power: 'mains', interconnected: true, as3786: false, manufactured: '2019-08-01' }),
    JSON.stringify(added?.attributes))
  log('and its make and expiry in their own fields', added?.make === 'Clipsal' && added.expiresOn === '2029-08-01' && added.installedOn === null)
  text = await panel().textContent()
  log('the panel lists it', /Smoke alarms \(3\)/.test(text) && /Photoelectric · 240 V hard-wired · Clipsal/.test(await row('Bedroom 1 alarm').textContent()))

  // Editing one.
  await row('Kitchen alarm').click()
  const edit = () => panel().getByRole('form', { name: 'Edit Kitchen alarm' })
  log('editing starts from what is recorded', (await edit().getByLabel('Sensor').inputValue()) === 'ionisation' && (await edit().getByLabel('Expires').inputValue()) === '2020-06-01')
  await edit().getByLabel('Name').fill('Kitchen alarm (old)')
  await edit().getByLabel('Sensor').selectOption({ label: 'Not recorded' })
  await edit().getByLabel('Manufactured').fill('2012-01-01')
  log('a typed expiry isn\'t moved by the manufacture date', (await edit().getByLabel('Expires').inputValue()) === '2020-06-01')
  await edit().getByRole('button', { name: 'Save' }).click()
  loc = await stored()
  const old = loc.assets.find(a => a.id === 'old')
  log('the edit is kept', old?.label === 'Kitchen alarm (old)' && old.attributes.manufactured === '2012-01-01')
  log('a field set back to "Not recorded" is cleared', !('sensor' in (old?.attributes ?? {})))
  log('and a detail this form doesn\'t know about survives', old?.attributes?.fitted_by === 'previous owner', JSON.stringify(old?.attributes))
  await row('Hallway alarm').click()
  await panel().getByRole('button', { name: 'Cancel' }).click()
  loc = await stored()
  log('cancelling changes nothing', JSON.stringify(loc.assets.find(a => a.id === 'soon')) === JSON.stringify(SEED[0].locations[0].assets[1]))

  // Replacing one from the panel (C2b).
  await row('Hallway alarm').click()
  await panel().getByRole('button', { name: 'Replace', exact: true }).click()
  const replaceForm = () => panel().getByRole('form', { name: 'Replace Hallway alarm' })
  log('the new alarm starts with the old one\'s name and room, and nothing else',
    (await replaceForm().getByLabel('Name').inputValue()) === 'Hallway alarm' && (await replaceForm().getByLabel('Room').inputValue()) === 'h' &&
      (await replaceForm().getByLabel('Expires').inputValue()) === '')
  await replaceForm().getByLabel('Sensor').selectOption({ label: 'Photoelectric' })
  await replaceForm().getByLabel('Manufactured').fill('2026-01-15')
  await replaceForm().getByRole('button', { name: 'Replace' }).click()
  loc = await stored()
  const hallOld = loc.assets.find(a => a.id === 'soon')
  const hallNew = loc.assets.find(a => a.attributes?.replaces === 'soon')
  log('replacing removes the old alarm', !!hallOld?.removedAt)
  log('and adds the new one in its place, at the same moment',
    hallNew?.label === 'Hallway alarm' && hallNew.roomId === 'h' && !hallNew.removedAt && hallNew.createdAt === hallOld?.removedAt && hallNew.expiresOn === '2036-01-15',
    JSON.stringify(hallNew))
  text = await panel().textContent()
  log('the panel lists the new one, and the old one as replaced',
    /Smoke alarms \(3\)/.test(text) && /Photoelectric/.test(await row('Hallway alarm').textContent()) && /Removed smoke alarms \(2\)/.test(text))
  // The removed list is still open from before.
  log('the old one says it was replaced', /Hallway alarm · Hallway · replaced/.test(await panel().textContent()))

  // Removing one.
  await row('Kitchen alarm (old)').click()
  await panel().getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  log('a removal can be cancelled', !(await stored()).assets.find(a => a.id === 'old').removedAt)
  await panel().getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click()
  loc = await stored()
  text = await panel().textContent()
  log('removing keeps it on record, as removed', !!loc.assets.find(a => a.id === 'old')?.removedAt && loc.assets.length === 5 && /Smoke alarms \(2\)/.test(text))
  log('and it\'s listed as removed, not replaced', /Kitchen alarm \(old\) · removed/.test(text))

  // The whole-site step tests the same alarms.
  await page.getByRole('button', { name: 'Start smoke alarm inspection' }).click()
  await page.getByRole('button', { name: /^Whole site/ }).click()
  log('the whole-site step tests the alarm added in the panel', (await page.getByRole('group', { name: 'Bedroom 1 alarm', exact: true }).count()) === 1)
  log('and not the removed one', (await page.getByRole('group', { name: 'Laundry alarm', exact: true }).count()) === 0)

  // Replacing a failed alarm from its note (C2b).
  const WORKS = 'Works when tested (replaced immediately if not)'
  const bed = () => page.getByRole('group', { name: 'Bedroom 1 alarm', exact: true })
  await bed().getByRole('button', { name: `${WORKS}: FAIL`, exact: true }).click()
  await page.getByRole('textbox', { name: `Bedroom 1 alarm — ${WORKS}`, exact: true }).fill('No sound when tested')
  log('a failed alarm\'s note offers to replace it', (await page.getByRole('button', { name: 'Replace Bedroom 1 alarm' }).count()) === 1)
  await page.getByRole('button', { name: 'Replace Bedroom 1 alarm' }).click()
  const noteForm = page.getByRole('form', { name: 'Replacing Bedroom 1 alarm' })
  await noteForm.getByLabel('Make').fill('Emerald')
  await noteForm.getByLabel('Power').selectOption({ label: 'Sealed 10-year battery' })
  await page.screenshot({ path: `${DIR}/equipment-replace.png`, fullPage: true })
  await noteForm.getByRole('button', { name: 'Replace' }).click()
  loc = await stored()
  const bedOld = loc.assets.find(a => a.id === added.id)
  const bedNew = loc.assets.find(a => a.attributes?.replaces === added.id)
  log('the failed alarm is replaced', !!bedOld?.removedAt && bedNew?.label === 'Bedroom 1 alarm' && bedNew.roomId === 'b1' && bedNew.make === 'Emerald')
  text = await page.textContent('main')
  log('its note says what replaced it', /Replaced with Bedroom 1 alarm\. Note why the old one failed\./.test(text) && (await page.getByRole('button', { name: /^Replace Bedroom 1 alarm/ }).count()) === 0)
  const each = loc.visits[0].siteResults.template.sections.find(s => s.assetType === 'smoke_alarm')
  const worksId = each.tests.find(t => t.label === WORKS).id
  log('the old alarm keeps its fail and its note, under its name',
    loc.visits[0].siteResults.results[each.id][added.id][worksId] === 'FAIL' &&
      loc.visits[0].siteResults.troubleshooting[`${added.id}:${worksId}`] === 'No sound when tested' &&
      (await page.getByRole('group', { name: 'Bedroom 1 alarm (replaced)', exact: true }).count()) === 1)
  log('and the new one is there to test', (await bed().count()) === 1 && (await bed().getByRole('button', { name: `${WORKS}: PASS`, exact: true }).getAttribute('aria-pressed')) !== 'true')
  log('Bedroom 1 is still covered', !/Bedroom 1 has no smoke alarm/.test(text))

  // An AV page.
  await openSite('#/maintenance')
  log('an AV site page has no equipment panel', (await panel().count()) === 0 && (await page.getByRole('button', { name: 'Start PM' }).count()) === 1)
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
