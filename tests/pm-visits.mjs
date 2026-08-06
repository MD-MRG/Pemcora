import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = (process.env.PEMCORA_BASE ?? 'http://localhost:5173/')
const URL = BASE + '#/maintenance'

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }) } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// c1 has floors+rooms; c2 has NO floors (scenario 1); c3 has a completed visit (scenario 4)
const SEED = [
  { id: 'c1', name: 'Equinix', locations: [
    { id: 'l1', address: '8 Grand Avenue', suburb: 'Rosehill', city: 'Sydney', state: 'NSW', postcode: '2142',
      floors: [
        { id: 'f1', label: 'Ground', rooms: [{ id: 'r1', name: 'Reception', planNumber: 'G-01' }] },
        { id: 'f2', label: 'Level 3', rooms: [
          { id: 'r2', name: 'Boardroom', planNumber: '3-01' },
          { id: 'r3', name: 'Huddle 3A', planNumber: '3-02' },
        ]},
      ], visits: [] },
    { id: 'l2', address: '639 Gardeners Road', suburb: 'Mascot', city: 'Sydney', state: 'NSW', postcode: '2020', floors: [], visits: [] },
  ]},
  { id: 'c2', name: 'Acme Industrial', locations: [
    { id: 'l4', address: '1 Smith Street', suburb: 'Parramatta', city: 'Sydney', state: 'NSW', postcode: '2150', floors: [], visits: [] },
  ]},
  { id: 'c3', name: 'Zenith Health', locations: [
    { id: 'l5', address: '99 Collins Street', suburb: 'Docklands', city: 'Melbourne', state: 'VIC', postcode: '3008',
      floors: [{ id: 'f9', label: 'Level 1', rooms: [{ id: 'r9', name: 'Clinic AV', planNumber: '1-01' }] }],
      visits: [{ id: 'v-old', startedAt: '2026-01-10T09:00:00.000Z', completedAt: '2026-01-10T15:00:00.000Z',
                 rooms: { r9: { status: 'complete', fails: 2 } }, exports: [{ revision: 1 }], exportPreference: null }] },
  ]},
]

const browser = await launch()
const page = await (await testContext(browser, { viewport: { width: 1440, height: 950 } })).newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')

async function reopen() {
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(150)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(350)
}
async function drill(clientName, addressText) {
  await reopen()
  await page.locator('tbody tr').filter({ hasText: clientName }).click()
  await page.waitForTimeout(350)
  await page.locator('tbody tr').filter({ hasText: addressText }).click()
  await page.waitForTimeout(400)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(s => localStorage.setItem('fc.clients', JSON.stringify(s)), SEED)
  await reopen()

  // 1 · levels 1 & 2 behave as on Edit Client
  const names = (await page.locator('tbody tr td:nth-child(1)').allTextContents())
    .map(n => n.replace(/\d+ locations/, '').trim())
  log('clients alphabetical', names.join('|') === 'Acme Industrial|Equinix|Zenith Health', names.join(' | '))
  const eqRow = (await page.locator('tbody tr').filter({ hasText: 'Equinix' }).textContent()).replace(/\s+/g, ' ')
  log('multi-location badge + joined values', /2 locations/.test(eqRow) && /Sydney/.test(eqRow), eqRow.trim())

  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.waitForTimeout(350)
  const heads = await page.locator('thead th').allTextContents()
  log('locations table columns', heads.join('|') === 'State|City|Street address|Suburb|Postcode', heads.join(' | '))

  // 3 · scenario 1 — no floors
  await drill('Acme Industrial', '1 Smith Street')
  let t = await body()
  log('no-rooms location: empty list + Add room offered',
    /No PM recorded for this location/.test(t) && /No rooms recorded/.test(t) &&
    (await page.getByRole('button', { name: /^\+ Add room$/ }).count()) === 1)
  await page.screenshot({ path: `${DIR}/pm-empty.png` })

  // 8 · add room creating a new floor
  await page.getByRole('button', { name: /^\+ Add room$/ }).click()
  await page.waitForTimeout(250)
  await page.getByLabel('New floor name').fill('Level 5')
  await page.getByLabel('Room name').fill('Server Room')
  await page.getByLabel('Floor plan no.').fill('5-01')
  await page.getByRole('button', { name: /^Add room$/ }).click()
  await page.waitForTimeout(500)
  t = await body()
  log('new floor + room appear in the list', /Level 5/.test(t) && /Server Room/.test(t))
  let s = await store()
  let loc = s.find(c => c.id === 'c2').locations[0]
  log('written to the CLIENT record, not just the visit',
    loc.floors.length === 1 && loc.floors[0].label === 'Level 5' && loc.floors[0].rooms[0].name === 'Server Room')

  // 4 · start PM
  await page.getByRole('button', { name: /^Start PM$/ }).click()
  await page.waitForTimeout(500)
  t = await body()
  log('Start PM opens a visit with progress', /in progress/i.test(t) && /0 of 1 rooms complete/.test(t), t.match(/\d+ of \d+ rooms complete/)?.[0])
  s = await store()
  log('visit written to the store', s.find(c => c.id === 'c2').locations[0].visits.length === 1)

  // 5 · resume after reload (scenario 3)
  await drill('Acme Industrial', '1 Smith Street')
  t = await body()
  log('open visit survives reload, offers Continue',
    /in progress/i.test(t) && (await page.getByRole('button', { name: /^Continue$/ }).count()) === 1)

  // 9 · add room onto an EXISTING floor lands in the right group
  await drill('Equinix', '8 Grand Avenue')
  await page.getByRole('button', { name: /^\+ Add room$/ }).click()
  await page.waitForTimeout(250)
  await page.getByLabel('Floor', { exact: true }).selectOption({ label: 'Level 3' })
  await page.getByLabel('Room name').fill('Huddle 3B')
  await page.getByRole('button', { name: /^Add room$/ }).click()
  await page.waitForTimeout(500)
  s = await store()
  loc = s.find(c => c.id === 'c1').locations[0]
  const ground = loc.floors.find(f => f.id === 'f1')
  const lvl3 = loc.floors.find(f => f.id === 'f2')
  log('room lands on the chosen floor, not the first',
    lvl3.rooms.length === 3 && ground.rooms.length === 1, `Ground=${ground.rooms.length} Level3=${lvl3.rooms.length}`)
  log('no duplicate floor created', loc.floors.length === 2, `${loc.floors.length} floors`)

  // 10 · grouping + chips + room navigation
  const groups = await page.locator('main section h3').allTextContents()
  log('rooms grouped under floor headings', groups.includes('Ground') && groups.includes('Level 3'), groups.join(' | '))
  log('status chips render', (await page.getByText('Not started').count()) >= 3)
  await page.screenshot({ path: `${DIR}/pm-rooms.png` })
  await page.getByRole('button', { name: /Boardroom/ }).click()
  await page.waitForTimeout(400)
  log('room opens read-only without a visit', /No visit has been started/.test(await body()))
  await page.getByRole('button', { name: /← Back/ }).click()
  await page.waitForTimeout(400)
  log('Back returns to the room list', /Add room/.test(await body()))

  // 6+7 · completed visit (scenario 4) and history
  await drill('Zenith Health', '99 Collins Street')
  t = await body()
  log('completed visit shows completion date', /Last visit completed/.test(t))
  log('offers Start new visit', (await page.getByRole('button', { name: /^Start new visit$/ }).count()) === 1)
  log('reports the export', /1 report\(s\) exported/.test(t))
  log('completed room keeps its FAIL chip', /2 FAILs/.test(t))
  await page.screenshot({ path: `${DIR}/pm-completed.png` })

  await page.getByRole('button', { name: /^Start new visit$/ }).click()
  await page.waitForTimeout(500)
  s = await store()
  const visits = s.find(c => c.id === 'c3').locations[0].visits
  log('new visit added, old one kept', visits.length === 2 && visits.some(v => v.id === 'v-old'), `${visits.length} visits`)
  log('past visit listed in history', /Past visits/.test(await body()))

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/pm-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
