// Proves the localStorage → Supabase import, against the live project.
//
//   node tests/migrate-e2e.mjs [email] [password]
//
// Seeds a browser with data of the shape the app has always written, signs in,
// runs the import from Settings, and then checks the rows FROM OUTSIDE the
// browser — the app would happily show its own cache either way.
//
// Also checks the two things most likely to go wrong quietly: that a client
// whose name already exists is skipped without taking the others down with it,
// and that nothing is removed from the device.

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright-core'
import { createClient } from '@supabase/supabase-js'

const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'
const STAMP = '1785995926141'
const EMAIL = process.argv[2] ?? `MDGhCode+rls-${STAMP}-owner@gmail.com`
const PASSWORD = process.argv[3] ?? `Test-${STAMP}-owner!`

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

let failures = 0
const log = (ok, name, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const TAG = Date.now()

// Real uuids, because that is what the app has always minted. The one client
// below with a deliberately malformed id covers the legacy path.
const IDS = {}
const uid = n => (IDS[n] ??= randomUUID())

// Deliberately the shape clientStore writes, nested visits and all.
const SEED = [
  {
    id: uid('c1'),
    name: `Equinix ${TAG}`,
    locations: [
      {
        id: uid('l1'),
        address: '8 Grand Avenue',
        suburb: 'Rosehill',
        city: 'Sydney',
        state: 'NSW',
        postcode: '2142',
        floors: [
          {
            id: uid('f1'),
            label: 'Ground',
            rooms: [
              { id: uid('r1'), name: 'Reception', planNumber: 'G-01' },
              { id: uid('r2'), name: 'Boardroom', planNumber: 'G-02' },
            ],
          },
        ],
        visits: [
          {
            id: uid('v1'),
            kind: 'maintenance',
            technician: 'Michal Dolezal',
            startedAt: '2026-07-01T00:00:00.000Z',
            completedAt: '2026-07-01T02:00:00.000Z',
            exportPreference: 'revision',
            rooms: {
              [uid('r1')]: {
                results: { main: { t1: 'PASS', t2: 'FAIL' } },
                sections: {},
                comments: 'Projector lamp is dim.',
                status: 'complete',
                fails: 1,
                template: {},
                touchedAt: '2026-07-01T01:00:00.000Z',
              },
            },
            exports: [{ revision: 1, filename: 'Equinix-PM-Rev1.xlsx', createdAt: '2026-07-01T02:00:00.000Z' }],
          },
        ],
      },
    ],
  },
  // Deliberately malformed ids, of the kind an older build or a hand-edited
  // export could leave behind. Postgres refuses these outright, so the import
  // has to remint them rather than lose the client.
  {
    id: `legacy-${TAG}-c2`,
    name: `Acme Industrial ${TAG}`,
    locations: [
      {
        id: `legacy-${TAG}-l2`,
        address: '1 Smith Street',
        suburb: 'Parramatta',
        city: 'Sydney',
        state: 'NSW',
        postcode: '2150',
        floors: [
          {
            id: `legacy-${TAG}-f2`,
            label: 'Level 1',
            rooms: [{ id: `legacy-${TAG}-r3`, name: 'Training Room', planNumber: 'L1-01' }],
          },
        ],
        visits: [
          {
            id: `legacy-${TAG}-v2`,
            kind: 'maintenance',
            technician: 'Legacy Tech',
            startedAt: '2026-06-01T00:00:00.000Z',
            completedAt: null,
            rooms: {
              // Keyed by the room's id — reminting the room without rewriting
              // this key would orphan the result.
              [`legacy-${TAG}-r3`]: {
                results: { main: { t1: 'PASS' } },
                sections: {},
                comments: 'Legacy note.',
                status: 'in-progress',
                fails: 0,
                template: {},
                touchedAt: '2026-06-01T01:00:00.000Z',
              },
            },
            exports: [],
          },
        ],
      },
    ],
  },
]

const SEED_SETTINGS = {
  company: { name: `Northpoint ${TAG}`, abn: '99 999 999 999', phone: '02 9000 0000', email: 'a@b.com' },
  technician: 'Imported Technician',
  plate: 'espresso',
  logoFull: null,
  logoCollapsed: null,
}

const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})
const signedIn = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (signedIn.error) {
  console.error(`FAIL  could not sign in as ${EMAIL}: ${signedIn.error.message}`)
  process.exit(1)
}
for (const t of (await sb.rpc('my_teams')).data ?? []) {
  await sb.from('teams').delete().eq('id', t.team_id)
}

const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await ctx.newPage()
const errs = []
page.on('console', m => {
  if (m.type() === 'error') errs.push(m.text())
})
page.on('pageerror', e => errs.push(e.message))

const TEAM = `Migrate ${TAG}`
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')

try {
  // ── Seed the browser as if this person had used the app offline ──────────
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(
    ([clients, settings]) => {
      localStorage.setItem('fc.clients', JSON.stringify(clients))
      localStorage.setItem('fc.settings', JSON.stringify(settings))
    },
    [SEED, SEED_SETTINGS],
  )

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForTimeout(2500)

  await page.getByLabel('Team name').fill(TEAM)
  await page.getByRole('button', { name: /create team/i }).click()
  await page.waitForTimeout(3000)

  const team = (await sb.rpc('my_teams')).data?.[0]
  log(!!team, 'team created', team?.name)

  // The team starts empty even though the browser is full — the import is
  // opt-in, and signing in must not quietly upload anything.
  const before = await sb.from('clients').select('id').eq('team_id', team.team_id)
  log((before.data ?? []).length === 0, 'signing in imported NOTHING on its own', `${before.data?.length ?? 0} clients`)

  // ── Run the import from Settings ─────────────────────────────────────────
  await page.goto(BASE + '#/settings', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  log(/Data on this device/.test(await body()), 'Settings offers the import')
  log(/2 clients/.test(await body()), 'it counts what is actually there', (await body()).match(/\d+ clients?, \d+ sites?, \d+ rooms?, \d+ visits?/)?.[0])

  await page.getByRole('button', { name: /import into this team/i }).click()
  await page.waitForTimeout(400)
  log(
    (await page.getByRole('dialog').count()) === 1 && /Everyone in this team/.test(await body()),
    'it confirms before writing to a shared team',
  )
  await page.getByRole('button', { name: /^Import$/ }).click()
  await page.waitForTimeout(6000)

  // ── Check what actually landed, from outside ─────────────────────────────
  const { data: clients, error: readErr } = await sb
    .from('clients')
    .select(
      'id, name, locations(id, address, floors(id, label, rooms(id, name, plan_number)), visits(id, kind, technician, completed_at, export_preference, visit_rooms(room_id, results, comments, status, fails), visit_exports(revision, filename)))',
    )
    .eq('team_id', team.team_id)

  // Without this, a broken verification query reads as "nothing was imported"
  // and sends you hunting through the app for a bug that is in the test.
  log(!readErr, 'verification query is valid', readErr ? `${readErr.code} ${readErr.message}` : '')
  log(clients?.length === 2, 'both clients reached Postgres', `${clients?.length ?? 0}`)

  const eq = clients?.find(c => c.name.startsWith('Equinix'))
  log(!!eq, 'the client with the full tree came across')
  log(eq?.locations?.[0]?.address === '8 Grand Avenue', 'its location came across', eq?.locations?.[0]?.address)
  log(eq?.locations?.[0]?.floors?.[0]?.rooms?.length === 2, 'both rooms came across', `${eq?.locations?.[0]?.floors?.[0]?.rooms?.length ?? 0}`)

  const visit = eq?.locations?.[0]?.visits?.[0]
  log(!!visit, 'the visit came across')
  log(visit?.technician === 'Michal Dolezal', 'visit technician preserved', visit?.technician)
  log(!!visit?.completed_at, 'visit stayed completed', visit?.completed_at)
  log(visit?.export_preference === 'revision', 'export preference preserved (0003 column)', visit?.export_preference)

  const vr = visit?.visit_rooms?.[0]
  log(!!vr, 'the room results came across')
  log(vr?.results?.main?.t2 === 'FAIL', 'results jsonb intact', JSON.stringify(vr?.results?.main))
  log(vr?.fails === 1 && vr?.status === 'complete', 'fails and status preserved', `${vr?.fails} / ${vr?.status}`)
  log(vr?.comments === 'Projector lamp is dim.', 'comments preserved')

  const ex = visit?.visit_exports?.[0]
  log(ex?.revision === 1 && ex?.filename === 'Equinix-PM-Rev1.xlsx', 'export record preserved (0003 column)', ex?.filename)

  // Valid ids must survive the trip, or later edits address nothing.
  log(eq?.id === uid('c1'), 'client kept the id it had on the device', eq?.id)
  log(eq?.locations?.[0]?.floors?.[0]?.id === uid('f1'), 'floor kept its id')

  // The legacy client's ids were unusable, so they had to be reminted — and the
  // result keyed by the old room id had to follow, or it would be orphaned.
  const acme = clients?.find(c => c.name.startsWith('Acme'))
  log(!!acme, 'the client with malformed ids was imported, not dropped')
  log(acme?.id !== `legacy-${TAG}-c2`, 'its id was reminted', acme?.id)
  const legacyRoom = acme?.locations?.[0]?.floors?.[0]?.rooms?.[0]
  const legacyVisitRoom = acme?.locations?.[0]?.visits?.[0]?.visit_rooms?.[0]
  log(!!legacyRoom && !!legacyVisitRoom, 'its room and visit came across too')
  log(
    legacyVisitRoom?.room_id === legacyRoom?.id,
    'the result still points at its room after reminting',
    `${legacyVisitRoom?.room_id} vs ${legacyRoom?.id}`,
  )
  log(legacyVisitRoom?.comments === 'Legacy note.', 'and its contents survived')

  const { data: ts } = await sb.from('team_settings').select('company, plate').eq('team_id', team.team_id).single()
  log(ts?.company?.name === SEED_SETTINGS.company.name, 'company details imported', ts?.company?.name)
  log(ts?.plate === 'espresso', 'plate imported', ts?.plate)

  const { data: prefs } = await sb.from('member_prefs').select('default_technician').eq('team_id', team.team_id).single()
  log(prefs?.default_technician === 'Imported Technician', 'technician imported to member_prefs', prefs?.default_technician)

  // ── Nothing removed from the device ──────────────────────────────────────
  const stillLocal = await page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
  log(stillLocal.length === 2, 'localStorage left untouched — the device keeps its copy', `${stillLocal.length} clients`)

  // ── Re-running skips duplicates without losing the rest ──────────────────
  await page.evaluate(() => localStorage.removeItem('fc.imported'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: /import into this team/i }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /^Import$/ }).click()
  await page.waitForTimeout(6000)

  const after = await sb.from('clients').select('id').eq('team_id', team.team_id)
  log((after.data ?? []).length === 2, 'a second run creates no duplicates', `${after.data?.length ?? 0} clients`)
  log(/could not be imported/i.test(await body()), 'and it says which ones it skipped, rather than failing silently')

  log(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  log(false, 'suite threw before finishing', e.message)
} finally {
  await browser.close()
  for (const t of (await sb.rpc('my_teams')).data ?? []) {
    await sb.from('teams').delete().eq('id', t.team_id)
  }
  console.log(`\n${failures === 0 ? 'All assertions passed.' : `${failures} assertion(s) FAILED.`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}
