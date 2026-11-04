/**
 * Step C1c: every workflow's page, label and room types from the pack registry.
 *
 * Runs the rules in Node first, then the real screens in a browser in test mode,
 * with a team's plan put on the page as DataBoot would.
 *
 *   node tests/workflow-pages.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - every workflow has a page, a label and a route, and Home's Resume goes there
 *   - a pack still marked proposed is never shown on not knowing: only to a team
 *     known to hold it, which on the live site only M.D. can give
 *   - room types are offered only to a team whose packs have them, so an AV team's
 *     editors are exactly as they were
 *   - a room's type is saved from both editors, and switches on the sections it names
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// ── The rules ───────────────────────────────────────────────────────────────
const { WORKFLOWS, PACKS } = await import('../src/data/packs/index.js')
const { usesPack, roomTypesFor } = await import('../src/lib/entitlements.js')
const { kindLabel, kindPath } = await import('../src/lib/home.js')
const { HOME_ROOM_TYPES } = await import('../src/data/packs/shared/roomTypes.js')

const plan = packs => ({ accountType: 'provider', packs })
const AV = plan(['core', 'av'])
const QLD = plan(['core', 'av', 'qld_electrical'])
const paths = WORKFLOWS.map(w => w.nav?.path)

log('every workflow has a page, a label and a blurb',
  WORKFLOWS.every(w => w.nav?.path?.startsWith('/') && w.nav.label && w.nav.blurb), JSON.stringify(WORKFLOWS.filter(w => !w.nav).map(w => w.id)))
log('no two share a route', new Set(paths).size === paths.length)
log('no two share a label', new Set(WORKFLOWS.map(w => w.nav.label)).size === WORKFLOWS.length)
log('the AV pages keep their routes and names',
  kindPath('maintenance') === '/maintenance' && kindPath('commissioning') === '/commissioning' && kindPath('custom') === '/custom-list' &&
    kindLabel('maintenance') === 'Preventative Maintenance' && kindLabel('commissioning') === 'Commissioning' && kindLabel('custom') === 'Custom List')
log('Home names another workflow\'s visit by its own name, not as PM',
  kindLabel('qld_smoke_alarm') === 'QLD smoke alarms' && kindPath('qld_smoke_alarm') === '/qld-smoke-alarm')
log('a visit with an unknown kind still reads as PM', kindLabel('nonsense') === 'Preventative Maintenance' && kindPath(undefined) === '/maintenance')

log('a proposed pack is never assumed', !usesPack(null, 'qld_electrical') && !usesPack(AV, 'vic_rental'))
log('only a team known to hold it uses it', usesPack(QLD, 'qld_electrical'))
log('the rest are assumed on not knowing, as before', usesPack(null, 'av') && usesPack(null, 'core'))

log('an AV team has no room types', roomTypesFor(AV).length === 0 && roomTypesFor(null).length === 0)
log('a team with an electrical pack has a home\'s', roomTypesFor(QLD).map(t => t.id).join() === HOME_ROOM_TYPES.map(t => t.id).join())
log('none twice, however many packs have them',
  roomTypesFor(plan(['core', 'qld_electrical', 'vic_rental', 'electrical_general'])).length === HOME_ROOM_TYPES.length)
log('the coverage rules name room types a team can give',
  PACKS.every(p => p.workflows.every(w => (w.seed.coverage ?? []).every(c => c.roomTypes.every(t => (p.roomTypes ?? []).some(x => x.id === t))))))

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
        floors: [{ id: 'f1', label: 'Ground', rooms: [{ id: 'r1', name: 'Bedroom 1', planNumber: '', roomType: 'bedroom' }] }],
        visits: [
          {
            id: 'v1',
            kind: 'qld_smoke_alarm',
            technician: 'Sam',
            startedAt: new Date(Date.now() - 3600000).toISOString(),
            completedAt: null,
            exports: [],
            exportPreference: null,
            rooms: {},
          },
        ],
      },
    ],
  },
]

// A list for the smoke alarm inspection with a room section that bedrooms switch on.
const TEMPLATE = {
  mainLabel: 'Main test list',
  tests: [{ id: 't1', label: 'Alarm visible', order: 0 }],
  sections: [
    { id: 'sb', label: 'In a bedroom', order: 0, roomTypes: ['bedroom'], tests: [{ id: 't2', label: 'Alarm on the ceiling', order: 0 }] },
    { id: 'sx', label: 'Anywhere', order: 1, tests: [{ id: 't3', label: 'Clear of the fan', order: 0 }] },
  ],
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))

  // What DataBoot does with a plan: the app's own copy of entitlements.js.
  const givePlan = packs =>
    page.evaluate(async packs => {
      const url = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
      const entitlements = await import(url ?? '/src/lib/entitlements.js')
      await entitlements.openEntitlements('team', 'user', {
        getEntitlements: async () => ({
          enforced: false, accountType: 'provider', plan: 'pro', isPro: true, seatLimit: 1, seatsUsed: 1,
          visitLimit: null, visitsUsed: 0, packs, pastDueUntil: null, cancelAt: null, importUsed: false,
          openVisits: 0, starterPack: packs[1] ?? null, starterInUse: true,
        }),
      })
    }, packs)
  const navLabels = () => page.locator('nav[aria-label="Main"] a').allTextContents()
  const load = async (address, packs) => {
    await page.goto(BASE + address, { waitUntil: 'networkidle' })
    if (packs) await givePlan(packs)
    await page.waitForTimeout(200)
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })

  // The navigation's rules. nav.js draws icons, so it runs here rather than in Node.
  const nav = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.includes('/src/nav.js')).pop()
    const { MAIN_NAV, navFor, redirectFor } = await import(url ?? '/src/nav.js')
    const plan = packs => ({ accountType: 'provider', packs })
    const AV = plan(['core', 'av'])
    const QLD = plan(['core', 'av', 'qld_electrical'])
    return {
      // After Home, Due (C4), New Client and Edit Client.
      order: MAIN_NAV.slice(4, 7).map(n => n.key).join(),
      unknown: navFor(null).map(n => n.path).join(),
      avElectrical: navFor(AV).some(n => n.pack === 'qld_electrical'),
      qldPages: navFor(QLD).filter(n => n.pack === 'qld_electrical').map(n => n.path).join(),
      withoutIt: redirectFor('/qld-smoke-alarm', AV, () => false),
      withIt: redirectFor('/qld-smoke-alarm', QLD, () => false),
      withVisits: redirectFor('/qld-smoke-alarm', AV, k => k === 'qld_smoke_alarm'),
    }
  })
  log('the AV pages keep their order in the navigation', nav.order === 'commissioning,maintenance,custom-list', nav.order)
  log('not knowing, the navigation is today\'s',
    nav.unknown === '/,/checks-due,/new-client,/edit-client,/commissioning,/maintenance,/custom-list,/teams', nav.unknown)
  log('an AV team sees no electrical pages', !nav.avElectrical)
  log('a team holding a pack sees its pages', nav.qldPages === '/qld-smoke-alarm,/qld-electrical-safety', nav.qldPages)
  log('a proposed pack\'s address goes Home for a team without it', nav.withoutIt === '/')
  log('and opens for a team with it', nav.withIt === null)
  log('and for a team with visits of it, so they can be read', nav.withVisits === null)

  await page.evaluate(([seed, template]) => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
    localStorage.setItem('fc.templates', JSON.stringify({ qld_smoke_alarm: template }))
  }, [SEED, TEMPLATE])

  // Not knowing what the team has: today's app.
  await load('#/')
  let labels = (await navLabels()).join()
  log('test mode shows today\'s navigation', !/QLD|VIC|Electrical|Smoke/i.test(labels), labels)

  await load('#/edit-client')
  await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
  await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  log('an AV team\'s floor plan editor has no room type', (await page.getByLabel(/room 1 type/).count()) === 0)

  // A team that holds the Queensland pack.
  await load('#/', ['core', 'av', 'qld_electrical'])
  labels = (await navLabels()).join()
  log('its pages are in the navigation', /QLD smoke alarms/.test(labels) && /QLD electrical safety/.test(labels), labels)
  const resume = await page.locator('li').filter({ hasText: 'Rental Co' }).textContent().catch(() => '')
  log('Home names its open visit by its own workflow', /QLD smoke alarms/.test(resume) && !/Preventative/.test(resume), resume)
  await page.getByRole('button', { name: 'Resume' }).first().click()
  await page.waitForTimeout(400)
  log('and Resume goes to its page', page.url().endsWith('#/qld-smoke-alarm') && /Smoke Alarm Compliance Inspection/.test(await page.textContent('main')), page.url())
  await page.screenshot({ path: `${DIR}/workflow-qld-page.png` })

  // The room type in the floor plan editor.
  await load('#/edit-client', ['core', 'av', 'qld_electrical'])
  await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
  await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  const typeOf1 = page.getByLabel('Floor 1 room 1 type')
  log('the floor plan editor offers a room type', (await typeOf1.count()) === 1)
  log('showing the room\'s own', (await typeOf1.inputValue()) === 'bedroom')
  await typeOf1.selectOption('hallway')
  await page.waitForTimeout(900)
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients'))[0].locations[0].floors[0].rooms)
  log('a changed type is saved with the room', (await stored())[0]?.roomType === 'hallway', JSON.stringify(await stored()))
  await typeOf1.selectOption('bedroom')
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${DIR}/workflow-room-types.png` })

  // Adding a room on the visit page, with a type.
  await load('#/qld-smoke-alarm', ['core', 'av', 'qld_electrical'])
  await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
  await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  await page.getByRole('button', { name: '+ Add room' }).click()
  await page.getByLabel('Room name').fill('Bedroom 2')
  await page.getByLabel('Room type').selectOption('bedroom')
  await page.getByRole('button', { name: 'Add room', exact: true }).click()
  await page.waitForTimeout(300)
  const added = (await stored()).find(r => r.name === 'Bedroom 2')
  log('a room added on the visit page keeps its type', added?.roomType === 'bedroom', JSON.stringify(added))

  // Opening a bedroom switches on the section bedrooms name, and only that one.
  await page.getByRole('button', { name: /^Bedroom 1/ }).click()
  await page.waitForTimeout(300)
  const toggle = label => page.locator('label').filter({ hasText: label }).locator('input[type="checkbox"]')
  log('a bedroom opens with its section switched on', await toggle('In a bedroom').isChecked())
  log('and the others as they were', !(await toggle('Anywhere').isChecked()))

  // An AV team doesn't get them, even with a type on a room.
  await load('#/maintenance', ['core', 'av'])
  await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
  await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  await page.getByRole('button', { name: '+ Add room' }).click()
  log('an AV team\'s Add room has no room type', (await page.getByLabel('Room type').count()) === 0)
  log('and an AV team\'s navigation has no electrical pages', !/QLD/.test((await navLabels()).join()))
  await load('#/qld-smoke-alarm', ['core', 'av'])
  await page.waitForTimeout(300)
  // A team without the pack is sent Home from its address (redirectFor, above),
  // unless it has visits of it on record, as this one does.
  log('with a visit of it on record, the page still opens to read it', page.url().endsWith('#/qld-smoke-alarm'), page.url())
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
