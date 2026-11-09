/**
 * Step D3c: "Save to your account" on a report link.
 *
 * The saving helpers in Node, then the page in a browser in test mode, with
 * the sign-in server and the database answered here as they would answer. It
 * signs in through the page's own form with a made-up account; nothing reaches
 * the live project.
 *
 *   node tests/report-save.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the page to:
 *   - signed out, it offers an account, and a sign-up made for a report comes
 *     back to that report once its email is confirmed
 *   - someone with no landlord or agency account makes one there, and the
 *     report is saved into it
 *   - a report not filed by itself asks which property, or makes one from the
 *     report's address under its owner: the electrician's client name filled in,
 *     and an owner of that name already in the account reused
 *   - one filed by itself says where; with two accounts, they choose
 *   - the wrong address is told so, with a way to sign out; the sender is told
 *     only the recipient can save it
 *   - a saved report opens for its own account, PDF and all, and no one else's
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'
const localhost = new URL(BASE).hostname

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

// ── The helpers ─────────────────────────────────────────────────────────────
const L = await import('../src/lib/reportLink.js')
const TOKEN = '6f1c2a9e-4b7d-4e2f-9a31-0c5d8e7f6a21'
const store = () => {
  const m = new Map()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }
}
let s = store()
L.rememberReport(TOKEN, s)
log('a report being saved is remembered, and given back once', L.takePendingReport(s) === TOKEN && L.takePendingReport(s) === null)
s = store()
L.rememberReport(TOKEN, s)
log('…for a week, no longer', L.takePendingReport(s, Date.now() + 8 * 24 * 3600e3) === null)
s = store()
s.setItem('pemcora.pendingReport', JSON.stringify({ token: 'not-a-token', at: Date.now() }))
log('…and never anything that isn\'t a report token', L.takePendingReport(s) === null)
log('a new account is named from the address', L.defaultAccountName('jane.citizen+rent@x.test') === "Jane Citizen's properties" && L.defaultAccountName('') === 'My properties')
log('properties list by address, with their owner',
  JSON.stringify(L.propertyChoices([{ name: 'Pat', locations: [{ id: 'b', address: '9 Zed St', suburb: 'Kew' }] }, { name: 'Jo', locations: [{ id: 'a', address: '1 Ann St', suburb: 'Kew' }] }]))
  === JSON.stringify([{ id: 'a', label: '1 Ann St, Kew', owner: 'Jo' }, { id: 'b', label: '9 Zed St, Kew', owner: 'Pat' }]))

// ── The stand-in sign-in server and database ────────────────────────────────
const SITE = { address: '10 Smith St', suburb: 'Toowong', state: 'QLD', postcode: '4066' }
const SNAPSHOT = { reportTitle: 'Smoke Alarm Compliance Inspection', client: 'Rental Co', provider: { name: 'Sparky team', company: { name: 'Sparky Co' } }, site: { failed: [] }, rooms: [] }
const PREVIEW = { status: 'ok', workflow: 'Smoke alarm', provider: 'Sparky team', completed_on: '2026-11-06', outcome: 'compliant', site: SITE, snapshot: SNAPSHOT, has_file: true, claimed: false }
const USER = { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'jane.citizen@landlord.test' }

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER.id, email: USER.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, session_id: 's1' })}.c2ln`
const userRow = () => ({ id: USER.id, aud: 'authenticated', role: 'authenticated', email: USER.email, email_confirmed_at: '2026-11-01T00:00:00Z', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-11-01T00:00:00Z' })

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
let server
const fresh = () => {
  server = {
    preview: [PREVIEW],
    teams: [],
    delivery: null,
    received: null,
    claim: 'unfiled',
    clients: [{ id: 'c-rental', name: 'rental co', team_id: 't', locations: [{ id: 'loc-other', address: '5 Other St', suburb: 'Kew', floors: [] }] }],
    calls: [],
    signedUp: null,
  }
}
fresh()

async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
  const path = url.pathname
  const body = req.postData() ? JSON.parse(req.postData()) : null
  server.calls.push({ method: req.method(), path, search: url.search, body, auth: req.headers().authorization })

  if (path === '/auth/v1/token') {
    return reply(200, { access_token: jwt(), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r1', user: userRow() })
  }
  if (path === '/auth/v1/signup') {
    server.signedUp = { email: body.email, redirect: url.searchParams.get('redirect_to') }
    return reply(200, { ...userRow(), email: body.email, email_confirmed_at: null, identities: [{ id: 'x' }] })
  }
  if (path === '/auth/v1/user') return reply(200, userRow())
  if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors })
  if (path === '/rest/v1/rpc/report_preview') return reply(200, server.preview)
  if (path === '/rest/v1/rpc/my_teams') return reply(200, server.teams.map(t => ({ team_id: t.id, name: t.name, role: 'owner', member_count: 1, admin_count: 1 })))
  if (path === '/rest/v1/teams' && req.method() === 'GET') return reply(200, server.teams.map(t => ({ id: t.id, name: t.name, account_type: t.accountType })))
  if (path === '/rest/v1/report_deliveries' && req.method() === 'GET') {
    const one = (req.headers().accept ?? '').includes('vnd.pgrst.object')
    if (one) return server.delivery ? reply(200, server.delivery) : reply(406, { code: 'PGRST116', message: 'no rows', details: 'The result contains 0 rows', hint: null })
    return reply(200, server.delivery ? [server.delivery] : [])
  }
  if (path === '/rest/v1/rpc/received_reports') {
    const one = (req.headers().accept ?? '').includes('vnd.pgrst.object')
    const asked = (url.searchParams.get('token') ?? '').replace('eq.', '')
    const row = server.received && server.received.token === asked ? server.received : null
    if (one) return row ? reply(200, row) : reply(406, { code: 'PGRST116', message: 'no rows', details: 'The result contains 0 rows', hint: null })
    return reply(200, row ? [row] : [])
  }
  if (path === '/rest/v1/rpc/create_organisation') {
    const team = { id: `team-${server.teams.length + 1}`, name: body.p_name, accountType: body.p_account_type }
    server.teams.push(team)
    return reply(200, [{ id: team.id }])
  }
  if (path === '/rest/v1/rpc/claim_report') {
    if (server.claim === 'wrong') return reply(400, { code: 'P0001', message: 'That report was sent to someone else, not to you', hint: null, details: null })
    return reply(200, { id: 'd1', recipient_team_id: body.p_team_id, recipient_location_id: server.claim === 'filed' ? 'loc-match' : null, site: SITE, snapshot: SNAPSHOT })
  }
  if (path === '/rest/v1/clients' && req.method() === 'GET') return reply(200, server.clients)
  if (path === '/rest/v1/clients' && req.method() === 'POST') {
    const row = { id: 'c-new', ...body, locations: [] }
    server.clients.push(row)
    return reply(201, row)
  }
  if (path === '/rest/v1/locations' && req.method() === 'POST') return reply(201, { id: 'loc-new', ...body, floors: [] })
  if (path === '/rest/v1/rpc/file_report') return reply(200, { id: body.p_delivery_id, recipient_location_id: body.p_location_id })
  if (path.startsWith('/storage/v1/object/sign/reports/') && req.method() === 'POST') {
    return reply(200, { signedURL: `/object/sign/reports/${path.slice('/storage/v1/object/sign/reports/'.length)}?token=mine` })
  }
  if (path.startsWith('/storage/v1/object/sign/reports/')) return route.fulfill({ status: 200, contentType: 'application/pdf', headers: cors, body: '%PDF-1.4 %%EOF' })
  return route.abort()
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  await ctx.route('**/*', backend)
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
  const body = () => page.textContent('body')
  const calls = name => server.calls.filter(c => c.path === name)
  const open = async () => {
    await page.evaluate(() => localStorage.clear())
    await page.goto(`${BASE}#/r/${TOKEN}`, { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await until(async () => /Smoke Alarm Compliance Inspection|saved to a Pemcora account|has expired/.test(await body()))
  }
  const signIn = async () => {
    await page.getByRole('button', { name: /I have an account|Sign in/ }).first().click()
    await page.getByLabel('Email').fill(USER.email)
    await page.getByLabel('Password').fill('a-test-password')
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click()
  }

  if (!configured) {
    console.log('(the page checks need VITE_SUPABASE_URL in .env, and were skipped; nothing is sent there)')
  } else {
    // ── Signed out ──────────────────────────────────────────────────────────
    await open()
    log('signed out, the report offers to be saved to an account', /Save this report to your account/.test(await body()) && (await page.getByRole('button', { name: 'Create a free account' }).count()) === 1)
    await page.getByRole('button', { name: 'Create a free account' }).click()
    log('"Create a free account" asks for the address it was sent to', await until(async () => /Use the email address the report was sent to/.test(await body())))
    log('…and remembers the report on this device', (await page.evaluate(() => JSON.parse(localStorage.getItem('pemcora.pendingReport'))?.token)) === TOKEN)
    await page.getByLabel('Email').fill(USER.email)
    await page.getByLabel('Password').fill('a-test-password')
    await page.locator('form').getByRole('button', { name: 'Create account' }).click()
    log('signing up says the confirmation brings them back to the report', await until(async () => /come back to the report to save it/.test(await body())))
    await page.getByRole('button', { name: 'Back to the report' }).click()
    log('"Back to the report" goes back to it', await until(async () => /A report sent to you from Sparky Co/.test(await body())))

    // The confirmation link opens the app; signed in there, they're taken back.
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    await until(async () => !/A report sent to you/.test(await body()))
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/supabase.js')).pop()
      const { supabase } = await import(url ?? '/src/lib/supabase.js')
      await supabase.auth.signInWithPassword({ email: 'jane.citizen@landlord.test', password: 'a-test-password' })
    })
    log('signed in after confirming, the app goes back to the report', await until(async () => (await page.evaluate(() => window.location.hash)) === `#/r/${TOKEN}`))
    log('…once: it\'s forgotten', (await page.evaluate(() => localStorage.getItem('pemcora.pendingReport'))) === null)

    // ── No landlord account yet: make one, save, file under a new property ──
    fresh()
    await open()
    await signIn()
    log('signed in with no landlord account, it offers to make one', await until(async () => /Save this report to a new account/.test(await body())))
    log('…named from their address', (await page.getByLabel('Account name').inputValue()) === "Jane Citizen's properties")
    await page.getByText('Property management').click()
    await page.getByRole('button', { name: 'Make the account and save' }).click()
    log('it asks which property, offering a new one from the report\'s address', await until(async () => /Which property is it for\?/.test(await body())) && /A new property: 10 Smith St, Toowong QLD 4066/.test(await body()))
    const made = calls('/rest/v1/rpc/create_organisation')[0]?.body ?? {}
    log('…having made a property management account', made.p_account_type === 'agency' && made.p_name === "Jane Citizen's properties" && !made.p_pack_id, JSON.stringify(made))
    const claimed = calls('/rest/v1/rpc/claim_report')[0]?.body ?? {}
    log('…and saved the report into it, by its token', claimed.p_token === TOKEN && claimed.p_team_id === 'team-1')
    log('the owner is the electrician\'s name for their client', (await page.getByLabel('Owner').inputValue()) === 'Rental Co')
    log('…and the account\'s own properties are offered too', /5 Other St, Kew/.test(await body()))
    await page.screenshot({ path: `${DIR}/report-save-file.png`, fullPage: true })
    await page.getByRole('button', { name: 'File it', exact: true }).click()
    log('filing says where it went', await until(async () => /Saved to Jane Citizen's properties, filed under 10 Smith St, Toowong QLD 4066\./.test(await body())))
    const placed = calls('/rest/v1/locations')[0]?.body ?? {}
    log('…under the owner already in the account, not a second one', calls('/rest/v1/clients').every(c => c.method !== 'POST') && placed.client_id === 'c-rental' && placed.team_id === 'team-1')
    log('…at the report\'s address', placed.address === '10 Smith St' && placed.suburb === 'Toowong' && placed.state === 'QLD' && placed.postcode === '4066')
    log('…then filed there', calls('/rest/v1/rpc/file_report')[0]?.body?.p_location_id === 'loc-new' && calls('/rest/v1/rpc/file_report')[0]?.body?.p_delivery_id === 'd1')
    await page.getByRole('button', { name: 'Open Pemcora' }).click()
    log('"Open Pemcora" opens the app', await until(async () => (await page.evaluate(() => window.location.hash)) === '#/'))

    // ── An existing property, and a new owner ───────────────────────────────
    fresh()
    server.teams = [{ id: 'team-a', name: 'Jane Rentals', accountType: 'landlord' }]
    await open()
    await signIn()
    await until(async () => (await page.getByRole('button', { name: 'Save to Jane Rentals' }).count()) === 1)
    log('with one landlord account, it saves straight to it', (await page.getByRole('button', { name: 'Save to Jane Rentals' }).count()) === 1 && (await page.getByLabel('Account').count()) === 0)
    await page.getByRole('button', { name: 'Save to Jane Rentals' }).click()
    await until(async () => /Which property is it for\?/.test(await body()))
    await page.getByRole('radio', { name: /5 Other St/ }).check()
    await page.getByRole('button', { name: 'File it', exact: true }).click()
    log('an existing property can be chosen', await until(async () => /Saved to Jane Rentals, filed under 5 Other St, Kew\./.test(await body())) && calls('/rest/v1/rpc/file_report')[0]?.body?.p_location_id === 'loc-other' && calls('/rest/v1/locations').length === 0)

    fresh()
    server.teams = [{ id: 'team-a', name: 'Jane Rentals', accountType: 'landlord' }]
    await open()
    await signIn()
    await page.getByRole('button', { name: 'Save to Jane Rentals' }).click()
    await until(async () => /Which property is it for\?/.test(await body()))
    await page.getByLabel('Owner').fill('Pat Owner')
    await page.getByRole('button', { name: 'File it', exact: true }).click()
    await until(async () => /filed under 10 Smith St/.test(await body()))
    const newOwner = calls('/rest/v1/clients').find(c => c.method === 'POST')?.body ?? {}
    log('a new owner\'s name makes a new owner', newOwner.name === 'Pat Owner' && newOwner.team_id === 'team-a' && calls('/rest/v1/locations')[0]?.body?.client_id === 'c-new')

    // ── Filed by itself; two accounts ───────────────────────────────────────
    fresh()
    server.teams = [{ id: 'team-a', name: 'Jane Rentals', accountType: 'landlord' }, { id: 'team-b', name: 'Jane Managed', accountType: 'agency' }]
    server.claim = 'filed'
    await open()
    await signIn()
    log('with two accounts, they choose', await until(async () => (await page.getByLabel('Account').count()) === 1))
    await page.getByLabel('Account').selectOption('team-b')
    await page.getByRole('button', { name: 'Save to Jane Managed' }).click()
    log('a report that files itself says where, with nothing to ask', await until(async () => /Saved to Jane Managed, filed under 10 Smith St, Toowong QLD 4066\./.test(await body())) && !/Which property/.test(await body()))
    log('…saved to the account chosen', calls('/rest/v1/rpc/claim_report')[0]?.body?.p_team_id === 'team-b')

    // ── The wrong address; the sender ───────────────────────────────────────
    fresh()
    server.teams = [{ id: 'team-a', name: 'Jane Rentals', accountType: 'landlord' }]
    server.claim = 'wrong'
    await open()
    await signIn()
    await page.getByRole('button', { name: 'Save to Jane Rentals' }).click()
    log('another address is told it was sent to someone else', await until(async () => /sent to someone else/.test(await body())))
    log('…with a way to sign out and use the right one', (await page.getByRole('button', { name: /Sign out, to sign in with the address/ }).count()) === 1)

    fresh()
    server.delivery = { id: 'd1', provider_team_id: 'team-p', recipient_team_id: null }
    await open()
    await signIn()
    log('the sender is told only the recipient can save it', await until(async () => /Your team sent this report\. Only the person it was sent to can save it\./.test(await body())))
    log('…and isn\'t offered an account', (await page.getByRole('button', { name: 'Make the account and save' }).count()) === 0)

    // ── Expired: still savable ──────────────────────────────────────────────
    fresh()
    server.preview = [{ ...PREVIEW, status: 'expired', snapshot: null, site: null }]
    await open()
    log('an expired link can still be saved', /This link has expired/.test(await body()) && /saving never expires/.test(await body()) && (await page.getByRole('button', { name: 'Create a free account' }).count()) === 1)

    // ── Saved: its own account opens it ─────────────────────────────────────
    fresh()
    server.preview = [{ ...PREVIEW, status: 'saved', snapshot: null, site: null, claimed: true }]
    server.teams = [{ id: 'team-a', name: 'Jane Rentals', accountType: 'landlord' }]
    // D4a (0013): the account it was saved to reads it through received_reports(), not the row.
    server.received = { id: 'd1', token: TOKEN, recipient_team_id: 'team-a', recipient_location_id: null, workflow_id: 'qld_smoke_alarm', completed_on: '2026-11-06', outcome: 'compliant', site: SITE, snapshot: SNAPSHOT, has_file: true, file_path: 'team-p/abc.pdf', files_itself: false }
    await open()
    log('a saved report asks them to sign in', (await page.getByRole('button', { name: 'Sign in' }).count()) === 1 && !/Toowong/.test(await body()))
    await signIn()
    log('signed in to its account, the report opens', await until(async () => /Sparky Co/.test(await body())) && /10 Smith St, Toowong QLD 4066/.test(await body()))
    log('…and, not filed yet, asks which property', /Which property is it for\?/.test(await body()))
    const popup = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null)
    await page.getByRole('button', { name: 'Open the PDF' }).click({ timeout: 5000 }).catch(() => {})
    const tab = await popup
    if (tab) await until(async () => tab.url().includes('token=mine'))
    log('its PDF opens through the account\'s own access, not the link', /\/storage\/v1\/object\/sign\/reports\/team-p\/abc\.pdf\?token=mine$/.test(tab?.url() ?? '') && calls('/functions/v1/report-file').length === 0, tab?.url())
    const signCall = server.calls.find(c => c.path.startsWith('/storage/v1/object/sign/reports/') && c.method === 'POST')
    log('…signed in as them', (signCall?.auth ?? '').startsWith('Bearer ey'))
    log('…read through received_reports(), never the delivery row', calls('/rest/v1/rpc/received_reports').length >= 1 && calls('/rest/v1/report_deliveries').length === 0)
    await tab?.close()

    fresh()
    server.preview = [{ ...PREVIEW, status: 'saved', snapshot: null, site: null, claimed: true }]
    server.delivery = { id: 'd1', provider_team_id: 'team-p', recipient_team_id: 'team-x' }
    await open()
    await signIn()
    log('the team that sent it is told its recipient saved it, and shown nothing more', await until(async () => /Your team sent this report, and the person it went to has saved it./.test(await body())) && !/Toowong/.test(await body()))

    fresh()
    server.preview = [{ ...PREVIEW, status: 'saved', snapshot: null, site: null, claimed: true }]
    server.delivery = null
    await open()
    await signIn()
    log('anyone else is told it went to another account', await until(async () => /saved to an account you aren.t signed in to/.test(await body())) && (await page.getByRole('button', { name: 'Sign out' }).count()) === 1)
    log('…and shown nothing of it', !/Toowong|Sparky Co/.test(await body()))
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
