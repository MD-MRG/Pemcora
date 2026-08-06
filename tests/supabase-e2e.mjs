// End-to-end proof that the Supabase adapter round-trips real data.
//
//   node tests/supabase-e2e.mjs [email] [password]
//
// Unlike the other suites this one does NOT set fc.testMode: it signs in
// through the real gate so the app runs on the Supabase adapter, not
// localStorage. It then drives the actual UI, reloads, and finally checks the
// rows from outside the browser — because "it still shows on screen" could just
// be the in-memory cache, and the point is to prove the data reached Postgres.
//
// Needs the dev server on 5173 and a confirmed account. Sign-up is closed on the
// project (confirmation is on), so it reuses one of the RLS suite's accounts by
// default rather than creating more.
//
// It creates a team, and deletes it at the end along with everything under it.

import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { createClient } from '@supabase/supabase-js'

const BASE = 'http://localhost:5173/'
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

// A second, independent view of the data — the browser's own client could be
// serving the cache, so verification has to come from outside it.
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})
const signedIn = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (signedIn.error) {
  console.error(`FAIL  could not sign in as ${EMAIL}: ${signedIn.error.message}`)
  process.exit(1)
}

// Start from no team so the app takes us through onboarding.
for (const t of (await sb.rpc('my_teams')).data ?? []) {
  await sb.from('teams').delete().eq('id', t.team_id)
}

const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
const page = await ctx.newPage()
const errs = []
page.on('console', m => {
  if (m.type() === 'error') errs.push(m.text())
})
page.on('pageerror', e => errs.push(e.message))

const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')
const TEAM = `E2E ${Date.now()}`
const CLIENT = `Adapter Test ${Date.now()}`

try {
  // ── Sign in through the real gate ────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE, { waitUntil: 'networkidle' })

  log((await page.getByRole('heading', { name: /sign in/i }).count()) === 1, 'gate shows sign-in')

  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForTimeout(2500)

  log(/name your team/i.test(await body()), 'no team yet, so onboarding appears')

  await page.getByLabel('Team name').fill(TEAM)
  await page.getByRole('button', { name: /create team/i }).click()
  await page.waitForTimeout(3000)

  log((await page.locator('nav a').count()) >= 7, 'app renders after the team is created')

  // ── Create a client with a location, floor and room ──────────────────────
  await page.goto(BASE + '#/new-client', { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)

  const inputs = page.locator('main section input')
  const vals = [CLIENT, '8 Grand Avenue', 'Rosehill', 'Sydney', 'NSW', '2142']
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(vals[i])
  await page.getByRole('button', { name: /^save client$/i }).click()
  await page.waitForTimeout(1200)

  log(/another floor/i.test(await body()), 'saved, and continued through to floors')

  // The floors editor is on screen; fill the first floor and room.
  const floorInputs = page.locator('main input')
  const n = await floorInputs.count()
  // last two text inputs on the page are the blank floor label + room name
  await floorInputs.nth(n - 3).fill('Ground')
  await floorInputs.nth(n - 2).fill('Reception')
  await floorInputs.nth(n - 1).fill('G-01')
  await page.waitForTimeout(2000) // debounced push

  // ── Reload: proves it came back from somewhere, not React state ──────────
  await page.goto(BASE + '#/edit-client', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  log(new RegExp(CLIENT).test(await body()), 'client survives a reload')

  // ── Verify from outside the browser ──────────────────────────────────────
  const teamRow = (await sb.rpc('my_teams')).data?.[0]
  log(!!teamRow && teamRow.name === TEAM, 'team row exists', teamRow?.name)

  const { data: clients } = await sb
    .from('clients')
    .select('id, name, locations(id, address, suburb, floors(id, label, rooms(id, name, plan_number)))')
    .eq('name', CLIENT)

  const c = clients?.[0]
  log(!!c, 'client row reached Postgres', c?.name)
  log(c?.locations?.length === 1, 'location row reached Postgres', `${c?.locations?.length ?? 0}`)
  log(
    c?.locations?.[0]?.address === '8 Grand Avenue' && c?.locations?.[0]?.suburb === 'Rosehill',
    'location fields mapped correctly',
    `${c?.locations?.[0]?.address} / ${c?.locations?.[0]?.suburb}`,
  )

  const floor = c?.locations?.[0]?.floors?.[0]
  log(floor?.label === 'Ground', 'floor row reached Postgres', floor?.label)
  const room = floor?.rooms?.[0]
  log(room?.name === 'Reception', 'room row reached Postgres', room?.name)
  log(room?.plan_number === 'G-01', 'planNumber mapped to plan_number', room?.plan_number)

  // ── Ids must be identical either side, or every later write misses ───────
  //
  // Proved behaviourally rather than by peering into the cache. A second edit
  // to the SAME floor is the sharpest test available: the app holds that
  // floor's client-minted id, so if Postgres had generated its own instead, the
  // new room would be inserted against a floor_id that does not exist — a
  // foreign-key error — or a duplicate floor would appear beside the first.
  const floorIdBefore = floor?.id

  await page.goto(BASE + '#/maintenance', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1800)
  await page.locator('tbody tr').filter({ hasText: CLIENT }).click()
  await page.waitForTimeout(600)
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(900)

  await page.getByRole('button', { name: /^\+ Add room$/ }).click()
  await page.waitForTimeout(400)
  // Onto the EXISTING floor, not a new one — that is the whole point.
  await page.getByLabel('Floor', { exact: true }).selectOption({ label: 'Ground' })
  await page.getByLabel('Room name').fill('Boardroom')
  await page.getByLabel('Floor plan no.').fill('G-02')
  await page.getByRole('button', { name: /^Add room$/ }).click()
  await page.waitForTimeout(2500)

  const { data: floorsAfter } = await sb
    .from('floors')
    .select('id, label, rooms(id, name)')
    .eq('location_id', c.locations[0].id)

  log(floorsAfter?.length === 1, 'still ONE floor — no duplicate was created', `${floorsAfter?.length ?? 0}`)
  log(
    floorsAfter?.[0]?.id === floorIdBefore,
    'the second room went onto the SAME floor id the app already held',
    `${floorsAfter?.[0]?.id} vs ${floorIdBefore}`,
  )
  log(
    floorsAfter?.[0]?.rooms?.length === 2,
    'both rooms are under that floor',
    (floorsAfter?.[0]?.rooms ?? []).map(r => r.name).join(', '),
  )

  const { data: after } = await sb.from('clients').select('id').eq('name', CLIENT)
  log(after?.length === 1, 'still exactly one client row', `${after?.length ?? 0}`)
  log(after?.[0]?.id === c.id, 'and it is the same client row throughout', after?.[0]?.id)

  // ── Settings split across three rows with three different owners ─────────
  await page.goto(BASE + '#/settings', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)

  await page.getByLabel('Company name').fill('Northpoint Audio Visual')
  await page.getByLabel('ABN').fill('12 345 678 901')
  await page.getByRole('button', { name: 'Background Espresso' }).click()
  await page.getByLabel('Default technician').fill('Michal Dolezal')
  await page.waitForTimeout(2500)

  const { data: ts } = await sb
    .from('team_settings')
    .select('company, plate')
    .eq('team_id', teamRow.team_id)
    .single()

  log(ts?.company?.name === 'Northpoint Audio Visual', 'company name reached team_settings', ts?.company?.name)
  log(ts?.company?.abn === '12 345 678 901', 'ABN reached team_settings', ts?.company?.abn)
  log(ts?.plate === 'espresso', 'brand plate reached team_settings', ts?.plate)

  // The technician is deliberately NOT team-wide: two technicians sharing a
  // team must not overwrite each other's name.
  const { data: prefs } = await sb
    .from('member_prefs')
    .select('default_technician')
    .eq('team_id', teamRow.team_id)
    .single()
  log(
    prefs?.default_technician === 'Michal Dolezal',
    'technician went to member_prefs, NOT team_settings',
    prefs?.default_technician,
  )
  log(
    ts?.company?.technician === undefined,
    'and team_settings does not carry a technician at all',
  )

  // ── Templates seed themselves into team_templates on first read ──────────
  const { data: tpl } = await sb
    .from('team_templates')
    .select('kind, template')
    .eq('team_id', teamRow.team_id)

  const maintenance = tpl?.find(t => t.kind === 'maintenance')?.template
  log(tpl?.length === 3, 'all three template rows exist', `${tpl?.length ?? 0}`)
  log(
    Array.isArray(maintenance?.tests) && maintenance.tests.length > 0,
    'maintenance template seeded from testLists.js into Postgres',
    `${maintenance?.tests?.length ?? 0} tests`,
  )
  log(
    (maintenance?.sections ?? []).some(s => s.label === 'Room controls'),
    'seeded template kept its sections',
    (maintenance?.sections ?? []).map(s => s.label).join(', '),
  )

  // ── And it all survives a real reload, from Postgres ─────────────────────
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  log(
    (await page.getByLabel('Company name').inputValue()) === 'Northpoint Audio Visual',
    'company name comes back after a full reload',
  )
  log(
    (await page.getByLabel('Default technician').inputValue()) === 'Michal Dolezal',
    'technician comes back after a full reload',
  )

  log(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | '))
} catch (e) {
  // Without this the finally below exits 0 on a mid-suite exception, and a run
  // that stopped a third of the way through reports "All assertions passed".
  log(false, 'suite threw before finishing', e.message)
} finally {
  await browser.close()
  for (const t of (await sb.rpc('my_teams')).data ?? []) {
    await sb.from('teams').delete().eq('id', t.team_id)
  }
  console.log(
    `\n${failures === 0 ? 'All assertions passed.' : `${failures} assertion(s) FAILED.`}\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}
