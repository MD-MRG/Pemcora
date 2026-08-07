import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const SEED = [
  {
    id: 'c1',
    name: 'Equinix',
    locations: [
      {
        id: 'l1',
        address: '8 Grand Avenue',
        suburb: 'Rosehill',
        city: 'Sydney',
        state: 'NSW',
        postcode: '2142',
        floors: [
          {
            id: 'f1',
            label: 'Ground',
            rooms: [
              { id: 'r1', name: 'Reception', planNumber: 'G-01' },
              { id: 'r2', name: 'Boardroom', planNumber: 'G-02' },
            ],
          },
        ],
        visits: [],
      },
    ],
  },
]

// What a technician would end up with after building a list in Settings.
const BUILT = {
  mainLabel: 'Main test list',
  tests: [
    { id: 't1', label: 'Rack power on', order: 0 },
    { id: 't2', label: 'Cable labelling', order: 1 },
  ],
  sections: [
    { id: 's1', label: 'Client checklist', order: 0, tests: [{ id: 't3', label: 'Signage correct', order: 0 }] },
  ],
}

const browser = await launch()
const ctx = await testContext(browser, { viewport: { width: 1440, height: 1000 } })
const page = await ctx.newPage()
const errs = []
page.on('console', m => {
  if (m.type() === 'error') errs.push(m.text())
})
page.on('pageerror', e => errs.push(e.message))

const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
const visits = async () => (await store())[0].locations[0].visits
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')

const setTemplates = t =>
  page.evaluate(v => {
    if (v) localStorage.setItem('fc.templates', JSON.stringify(v))
    else localStorage.removeItem('fc.templates')
  }, t)

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
  await page.evaluate(s => localStorage.setItem('fc.clients', JSON.stringify(s)), SEED)

  // ── 1 · Unbuilt: the one way this workflow differs from the other two ─────
  await setTemplates(null)
  await page.goto(BASE + '#/custom-list', { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  let t = await body()
  log('empty list explains itself instead of showing the client browser', /Build your custom list first/.test(t))
  log('it does NOT drop you into client selection', !/CLIENT\s+STATE/.test(t) && (await page.locator('tbody tr').count()) === 0)
  log('and it offers the way out', (await page.getByRole('link', { name: /open settings/i }).count()) === 1)
  await page.screenshot({ path: `${DIR}/custom-unbuilt.png` })

  // Maintenance seeds ~60 tests from testLists.js, so it must NOT be gated.
  await page.goto(BASE + '#/maintenance', { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  log('the gate is specific to Custom List, not the shared workflow', !/Build your custom list first/.test(await body()))

  // ── 2 · Built: the same workflow as the other two ────────────────────────
  await setTemplates({ custom: BUILT })
  await openLocation('#/custom-list')
  t = await body()
  log('with a list built, it behaves like the other workflows', /No custom list recorded for this location/.test(t))
  log('offers its own start wording', (await page.getByRole('button', { name: /^Start custom list$/ }).count()) === 1)

  await page.getByRole('button', { name: /^Start custom list$/ }).click()
  await page.waitForTimeout(500)
  log('visit opens', /Custom list in progress/.test(await body()))

  let v = await visits()
  log('visit recorded with kind "custom"', v.length === 1 && v[0].kind === 'custom', JSON.stringify(v.map(x => x.kind)))

  // ── 3 · The room renders the technician's own tests ──────────────────────
  await page.getByText('Reception', { exact: false }).first().click()
  await page.waitForTimeout(600)
  t = await body()
  log('the built tests render', /Rack power on/.test(t) && /Cable labelling/.test(t))
  log('the named section renders', /Client checklist/.test(t))
  log('no maintenance tests leaked in', !/Correct date and time/.test(t))
  await page.screenshot({ path: `${DIR}/custom-room.png` })

  await page.getByRole('button', { name: 'PASS' }).first().click()
  await page.waitForTimeout(400)
  v = await visits()
  const entry = v.find(x => x.kind === 'custom')?.rooms?.r1
  log('a result saves against the custom visit', entry && Object.keys(entry.results?.main ?? {}).length === 1, JSON.stringify(entry?.results?.main))

  // The snapshot rule: the room keeps the list it was filled in against.
  log('the room snapshotted the custom template', (entry?.template?.tests ?? []).some(x => x.label === 'Rack power on'))

  // ── 4 · Its history is its own ───────────────────────────────────────────
  await openLocation('#/maintenance')
  log('the custom visit does NOT appear under Preventative Maintenance', /No PM recorded for this location/.test(await body()))

  await page.getByRole('button', { name: /^Start PM$/ }).click()
  await page.waitForTimeout(500)
  v = await visits()
  log('a PM opens alongside the custom list, not instead of it', v.length === 2, JSON.stringify(v.map(x => x.kind)))
  log('both remain open at once', v.filter(x => !x.completedAt).length === 2)

  await openLocation('#/custom-list')
  log('the custom list still shows its own visit, not the PM', /Custom list in progress/.test(await body()))

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  await browser.close()
}
