/**
 * Step C2: the equipment panel on a site's page.
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

  // The whole-site step tests the same alarms.
  await page.getByRole('button', { name: 'Start smoke alarm inspection' }).click()
  await page.getByRole('button', { name: /^Whole site/ }).click()
  log('the whole-site step tests the alarm added in the panel', (await page.getByRole('group', { name: 'Bedroom 1 alarm', exact: true }).count()) === 1)
  log('and not the removed one', (await page.getByRole('group', { name: 'Laundry alarm', exact: true }).count()) === 0)

  // An AV page.
  await openSite('#/maintenance')
  log('an AV site page has no equipment panel', (await panel().count()) === 0 && (await page.getByRole('button', { name: 'Start PM' }).count()) === 1)
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
