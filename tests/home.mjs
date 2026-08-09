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

const D = d => new Date(Date.now() - d * 86400000).toISOString()
const exports_ = n =>
  Array.from({ length: n }, (_, i) => ({
    revision: i + 1,
    filename: `r${i + 1}.xlsx`,
    createdAt: D(20 - i),
  }))

// One seed exercising every rule on the page at once:
//   · Equinix has an OPEN PM with a noted FAIL and an unnoted one, plus a FAIL
//     inside a switched-OFF section that must stay invisible
//   · Telstra has a finished PM that was never exported, whose unnoted FAIL must
//     NOT be flagged (its rooms are read-only, so the flag would be a dead end)
//   · Vocus and Optus share one address, to prove locations count distinctly
//   · Optus has no floor plan at all
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
        visits: [
          {
            id: 'v1',
            kind: 'maintenance',
            technician: 'Tech',
            startedAt: D(3),
            completedAt: null,
            exports: [],
            exportPreference: null,
            rooms: {
              r1: {
                results: { main: { a: 'FAIL', b: 'FAIL' }, s1: { c: 'FAIL' } },
                sections: { s1: false },
                troubleshooting: { a: 'Lead replaced' },
                comments: '',
                status: 'complete',
                fails: 2,
                touchedAt: D(1),
              },
            },
          },
        ],
      },
      {
        id: 'l2',
        address: '47 Bourke Road',
        suburb: 'Alexandria',
        city: 'Sydney',
        state: 'NSW',
        postcode: '2015',
        floors: [{ id: 'f2', label: 'Level 5', rooms: [{ id: 'r3', name: 'Training', planNumber: '5-01' }] }],
        visits: [
          { id: 'v2', kind: 'maintenance', startedAt: D(22), completedAt: D(20), exports: exports_(3), rooms: {} },
          { id: 'v3', kind: 'commissioning', startedAt: D(42), completedAt: D(40), exports: exports_(2), rooms: {} },
        ],
      },
    ],
  },
  {
    id: 'c2',
    name: 'Telstra',
    locations: [
      {
        id: 'l3',
        address: '242 Exhibition Street',
        suburb: 'Melbourne',
        city: 'Melbourne',
        state: 'VIC',
        postcode: '3000',
        floors: [{ id: 'f3', label: 'Level 12', rooms: [{ id: 'r4', name: 'Boardroom', planNumber: '12-01' }] }],
        visits: [
          {
            id: 'v4',
            kind: 'commissioning',
            startedAt: D(9),
            completedAt: null,
            exports: [],
            rooms: { r4: { results: { main: { a: 'PASS' } }, sections: {}, status: 'complete', fails: 0, touchedAt: D(9) } },
          },
          {
            id: 'v5',
            kind: 'maintenance',
            startedAt: D(62),
            completedAt: D(60),
            exports: [],
            rooms: {
              r4: {
                results: { main: { a: 'FAIL' } },
                sections: {},
                troubleshooting: {},
                status: 'complete',
                fails: 1,
                touchedAt: D(60),
              },
            },
          },
        ],
      },
    ],
  },
  {
    id: 'c3',
    name: 'Vocus',
    locations: [
      {
        id: 'l4',
        address: '1 Martin Place',
        suburb: 'Sydney',
        city: 'Sydney',
        state: 'NSW',
        postcode: '2000',
        floors: [{ id: 'f4', label: 'Ground', rooms: [{ id: 'r5', name: 'Reception', planNumber: 'G-01' }] }],
        visits: [],
      },
    ],
  },
  {
    id: 'c4',
    name: 'Optus',
    locations: [
      {
        id: 'l5',
        address: '1 Martin Place',
        suburb: 'Sydney',
        city: 'Sydney',
        state: 'NSW',
        postcode: '2000',
        floors: [],
        visits: [],
      },
    ],
  },
]

const browser = await launch()
const ctx = await testContext(browser, { viewport: { width: 1440, height: 1000 } })
const page = await ctx.newPage()
const errs = []
page.on('console', m => {
  if (m.type() === 'error') errs.push(m.text())
})
page.on('pageerror', e => errs.push(e.message))

const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')

// The figure printed under a given stat label.
const stat = label =>
  page.evaluate(l => {
    const tiles = [...document.querySelectorAll('section[aria-label="Totals"] > div')]
    const tile = tiles.find(d => d.querySelector('p')?.textContent.trim() === l)
    return tile?.querySelectorAll('p')[1]?.textContent.trim() ?? null
  }, label)

// A named section's rows, by the panel heading above it.
const rowsUnder = heading =>
  page.evaluate(h => {
    const head = [...document.querySelectorAll('h2')].find(x =>
      x.textContent.toLowerCase().startsWith(h.toLowerCase()),
    )
    return [...(head?.nextElementSibling?.querySelectorAll('li') ?? [])].map(li =>
      li.textContent.replace(/\s+/g, ' ').trim(),
    )
  }, heading)

async function goHome(seed) {
  await page.evaluate(s => localStorage.setItem('fc.clients', JSON.stringify(s)), seed)
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(350)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })

  // ── 1 · The empty state, before anything exists ──────────────────────────
  await goHome([])
  let t = await body()
  log('with no clients it says so rather than showing four zeros', /No clients yet/.test(t))
  log('and offers both ways to get data in', /Add a client/.test(t) && /Open Settings/.test(t))
  log('no stat tiles in the empty state', (await page.locator('section[aria-label="Totals"]').count()) === 0)
  await page.screenshot({ path: `${DIR}/home-empty.png` })

  // ── 2 · The four figures ─────────────────────────────────────────────────
  await goHome(SEED)
  log('Clients counts distinct names', (await stat('Clients')) === '4', await stat('Clients'))
  // Five location records, but Vocus and Optus share 1 Martin Place.
  log(
    'Locations counts distinct address + suburb + city, not records',
    (await stat('Locations')) === '4',
    await stat('Locations'),
  )
  log('PM reports counts maintenance export records', (await stat('PM reports')) === '3', await stat('PM reports'))
  log(
    'Commissioning reports counts only commissioning',
    (await stat('Commissioning reports')) === '2',
    await stat('Commissioning reports'),
  )
  await page.screenshot({ path: `${DIR}/home-overview.png`, fullPage: true })

  // ── 3 · Pick up where you left off ───────────────────────────────────────
  let rows = await rowsUnder('pick up where you left off')
  log('both open visits are listed', rows.length === 2, JSON.stringify(rows.length))
  log('newest first', /Equinix/.test(rows[0] ?? '') && /Telstra/.test(rows[1] ?? ''))
  log('each names its workflow', /Preventative Maintenance/.test(rows[0]) && /Commissioning/.test(rows[1]))
  log('room progress is counted against the floor plan', /1 of 2 rooms complete/.test(rows[0]), rows[0])
  log('FAILs surface on the row', /2 FAILs/.test(rows[0]))
  log('finished visits are NOT listed as in progress', !rows.some(r => /47 Bourke/.test(r)))

  // ── 4 · Needs attention ──────────────────────────────────────────────────
  rows = await rowsUnder('needs attention')
  log('three things flagged', rows.length === 3, JSON.stringify(rows))
  log('a finished visit with no report is flagged', /REPORT NOT SENT/i.test(rows[0]) && /Telstra/.test(rows[0]))
  log('an unnoted FAIL on an OPEN visit is flagged', /FAILS WITHOUT NOTES/i.test(rows[1]) && /Reception/.test(rows[1]))
  log('the FAIL that already has a note is not counted', /1 FAIL with nothing/.test(rows[1]), rows[1])
  log('a FAIL inside a switched-OFF section stays invisible', !/2 FAILs with nothing/.test(rows[1]))
  // The room of a finished visit is read-only, so flagging it would send the
  // technician somewhere they cannot write the note.
  log(
    'an unnoted FAIL on a FINISHED visit is not flagged',
    !rows.some(r => /FAILS WITHOUT NOTES/i.test(r) && /Boardroom/.test(r)),
    JSON.stringify(rows.filter(r => /FAILS/i.test(r))),
  )
  log('a location with no floor plan is flagged', /NO ROOMS RECORDED/i.test(rows[2]) && /Optus/.test(rows[2]))

  // ── 5 · The deep link — the whole point of the page ──────────────────────
  await page.getByRole('button', { name: 'Resume' }).first().click()
  await page.waitForTimeout(500)
  t = await body()
  log('Resume opens the right workflow at the right location', /Preventative Maintenance — Equinix/.test(t))
  log('and lands on the visit, not the client list', /Preventative Maintenance in progress/.test(t))
  log('the location is the one that was resumed', /8 Grand Avenue/.test(t))

  // A hard reload keeps the resumed location. HashRouter plus history state
  // gives this for free, and it is what should happen — a technician who
  // refreshes mid-visit must not be thrown back to the client list.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  log('a hard reload holds the resumed location', /Preventative Maintenance — Equinix/.test(await body()))

  // Arriving from the side nav carries no router state, so the workflow must
  // open on the client list exactly as it always has.
  await goHome(SEED)
  await page.getByRole('link', { name: 'Preventative Maintenance', exact: true }).first().click()
  await page.waitForTimeout(500)
  log(
    'reaching the workflow from the nav still opens the client list',
    (await page.locator('tbody tr').count()) > 0 && !/in progress/.test(await body()),
  )

  await goHome(SEED)
  await page.getByRole('button', { name: 'Open room' }).first().click()
  await page.waitForTimeout(600)
  t = await body()
  log('a flagged FAIL opens that exact room', /Reception/.test(t) && /Equinix · Ground/.test(t))
  log('and the room is editable, not the read-only view', !/This visit is finished/.test(t))

  await goHome(SEED)
  await page.getByRole('button', { name: 'Add rooms' }).first().click()
  await page.waitForTimeout(600)
  t = await body()
  log('Add rooms opens that location in the floors editor', /Edit Optus/.test(t) && /1 Martin Place/.test(t))

  // ── 6 · Quiet states ─────────────────────────────────────────────────────
  await goHome([
    { id: 'q1', name: 'Quiet Co', locations: [
      { id: 'ql', address: '1 Calm Street', suburb: 'Peace', city: 'Sydney', state: 'NSW', postcode: '2000',
        floors: [{ id: 'qf', label: 'Ground', rooms: [{ id: 'qr', name: 'Room', planNumber: '1' }] }],
        visits: [{ id: 'qv', kind: 'maintenance', startedAt: D(5), completedAt: D(4), exports: exports_(1), rooms: {} }] },
    ] },
  ])
  t = await body()
  log('nothing open says so', /Nothing in progress/.test(t))
  log('nothing wrong says so', /All clear/.test(t))
  log('the figures still show', (await stat('Clients')) === '1' && (await stat('PM reports')) === '1')

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  await browser.close()
}
