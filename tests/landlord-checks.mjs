/**
 * Step D4d: a landlord's own checks, their certificates, and the Due page.
 *
 * The certificate rules in Node, then the pages in a browser in test mode as a
 * landlord account, with compliance_items, the photo bucket and due_list()
 * answered here as the database would answer them. Nothing reaches the live
 * project.
 *
 *   node tests/landlord-checks.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the pages to:
 *   - a check is a name, every how many months, and when it was last done; the
 *     same name twice at a property is refused in words
 *   - a check entered by hand can be done again, given a certificate (a PDF or a
 *     photo, up to 10 MB) and removed, its certificate with it; a check a report
 *     keeps can't be
 *   - a certificate replaced takes the old file away; on Free with limits on,
 *     certificates say they're Pro's
 *   - the Due page lists the landlord's checks by owner, with no reminder switches
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

// ── The rules ───────────────────────────────────────────────────────────────
const P = await import('../src/lib/properties.js')
const { ownObligation } = await import('../src/lib/api.js').catch(() => ({}))
const f = (type, size = 1000) => ({ type, size })
log('a PDF or a photo can be a certificate', ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].every(t => P.certificateProblem(f(t)) === null))
log('…nothing else', /PDF or a photo/.test(P.certificateProblem(f('text/plain')) ?? '') && /PDF or a photo/.test(P.certificateProblem(f('image/heic')) ?? ''))
log('…and nothing over 10 MB', /over 10 MB/.test(P.certificateProblem(f('application/pdf', 10 * 1024 * 1024 + 1)) ?? '') && P.certificateProblem(f('application/pdf', 10 * 1024 * 1024)) === null)
log('a check entered by hand is marked so; one a report keeps is not',
  P.propertyCards([{ id: 'c', name: 'O', locations: [{ id: 'l', address: 'A' }] }], [
    { id: 'a', location_id: 'l', obligation: 'own:gas-check', label: 'Gas', next_due_on: '2030-01-01' },
    { id: 'b', location_id: 'l', obligation: 'vic_smoke_alarm', label: 'Smoke', next_due_on: '2030-01-01' },
  ], [], '2026-11-09')[0].checks.map(c => `${c.id}:${c.own}`).sort().join() === 'a:true,b:false')
if (ownObligation) log('its name in the database is its own', ownObligation('  Gas  Check!! ') === 'own:gas-check' && ownObligation('') === 'own:check')

// ── The pages ───────────────────────────────────────────────────────────────
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const TEAM = '66666666-6666-4666-8666-666666666666'
const FREE = { enforced: false, accountType: 'landlord', plan: 'free', isPro: false, packs: ['core'], starterPack: null, starterInUse: false }
const SEED = [
  { id: 'c-rental', name: 'Rental Co', contactName: '', contactEmail: '', contactPhone: '', remindersEnabled: true, locations: [{ id: 'loc-a', address: '10 Smith St', suburb: 'Toowong', city: '', state: 'QLD', postcode: '4066', floors: [], visits: [], assets: [] }] },
  { id: 'c-pat', name: 'Pat Owner', contactName: '', contactEmail: '', contactPhone: '', remindersEnabled: true, locations: [{ id: 'loc-b', address: '9 Zed St', suburb: 'Kew', city: '', state: 'VIC', postcode: '3101', floors: [], visits: [], assets: [] }] },
]
const REPORT_CHECK = { id: 'i-report', location_id: 'loc-a', obligation: 'qld_smoke_alarm', label: 'Smoke alarm compliance inspection', satisfied_by: null, interval_months: 12, last_done_on: '2026-01-01', next_due_on: '2027-01-01', evidence_path: null, active: true }

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const server = { items: [REPORT_CHECK], calls: [], uploadRefused: false, seq: 0 }
const addMonths = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}
async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
  const raw = req.postDataBuffer()
  let body = null
  try {
    body = raw ? JSON.parse(raw.toString()) : null
  } catch {}
  server.calls.push({ method: req.method(), path: url.pathname, search: decodeURIComponent(url.search), body, type: req.headers()['content-type'], raw })
  const id = (url.searchParams.get('id') ?? '').replace('eq.', '')

  if (url.pathname === '/rest/v1/compliance_items' && req.method() === 'GET') return reply(200, server.items)
  if (url.pathname === '/rest/v1/compliance_items' && req.method() === 'POST') {
    if (server.items.some(i => i.location_id === body.location_id && i.obligation === body.obligation)) {
      return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null })
    }
    const row = { id: `i-own-${++server.seq}`, satisfied_by: null, evidence_path: null, active: true, ...body, next_due_on: addMonths(body.last_done_on, body.interval_months) }
    server.items.push(row)
    return reply(201, { id: row.id })
  }
  if (url.pathname === '/rest/v1/compliance_items' && req.method() === 'PATCH') {
    const row = server.items.find(i => i.id === id)
    if (row) {
      Object.assign(row, body)
      if (body.last_done_on) row.next_due_on = addMonths(body.last_done_on, row.interval_months)
    }
    return route.fulfill({ status: 204, headers: cors })
  }
  if (url.pathname === '/rest/v1/compliance_items' && req.method() === 'DELETE') {
    server.items = server.items.filter(i => !(i.id === id && i.obligation.startsWith('own:')))
    return route.fulfill({ status: 204, headers: cors })
  }
  if (url.pathname === '/rest/v1/rpc/received_reports') return reply(200, [])
  if (url.pathname.startsWith('/storage/v1/object/evidence/') && req.method() === 'POST') {
    if (server.uploadRefused) return reply(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' })
    return reply(200, { Key: url.pathname.slice('/storage/v1/object/'.length) })
  }
  if (url.pathname === '/storage/v1/object/evidence' && req.method() === 'DELETE') return reply(200, [])
  if (url.pathname.startsWith('/storage/v1/object/sign/evidence/') && req.method() === 'POST') {
    return reply(200, { signedURL: `/object/sign/evidence/${url.pathname.slice('/storage/v1/object/sign/evidence/'.length)}?token=cert` })
  }
  if (url.pathname.startsWith('/storage/v1/object/sign/evidence/')) return route.fulfill({ status: 200, contentType: 'application/pdf', headers: cors, body: '%PDF-1.4 %%EOF' })
  if (url.pathname === '/rest/v1/rpc/due_list') {
    return reply(200, [
      { kind: 'overdue', due_on: '2026-10-01', item_id: 'd1', obligation: 'own:gas-check', label: 'Gas check', last_done_on: '2024-10-01', reminders_enabled: true, client_id: 'c-rental', client_name: 'Rental Co', location_id: 'loc-a', address: '10 Smith St', suburb: 'Toowong' },
      { kind: 'due', due_on: '2026-12-01', item_id: 'd2', obligation: 'vic_smoke_alarm', label: 'Smoke alarm safety check', last_done_on: '2025-12-01', reminders_enabled: true, client_id: 'c-pat', client_name: 'Pat Owner', location_id: 'loc-b', address: '9 Zed St', suburb: 'Kew' },
    ])
  }
  if (url.pathname === '/rest/v1/rpc/due_opt_outs') return reply(200, [])
  return route.abort()
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
  const main = () => page.textContent('main')
  const calls = (path, method) => server.calls.filter(c => c.path === path && (!method || c.method === method))
  const smith = () => page.getByRole('listitem', { name: '10 Smith St, Toowong QLD 4066' })
  const asLandlord = e =>
    page.evaluate(
      async ({ team, e }) => {
        const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
        const mod = await import(url ?? '/src/lib/entitlements.js')
        await mod.openEntitlements(team, 'user', { getEntitlements: async () => e })
      },
      { team: TEAM, e },
    )
  const open = async (hash, e = FREE) => {
    await page.goto(BASE + hash, { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await asLandlord(e)
  }
  await page.evaluate(seed => localStorage.setItem('fc.clients', JSON.stringify(seed)), SEED)

  if (!configured) {
    console.log('(the page checks need VITE_SUPABASE_URL in .env, and were skipped; nothing is sent there)')
  } else {
    await open('#/properties')
    await until(async () => /Smoke alarm compliance inspection/.test(await main()))
    log('a check a report keeps can\'t be done, given a certificate or removed here',
      (await smith().getByRole('button', { name: /Record .* as done|Remove/ }).count()) === 0 && (await smith().getByLabel(/Certificate for/).count()) === 0)

    // Adding one.
    await smith().getByRole('button', { name: 'Add a check at 10 Smith St, Toowong QLD 4066' }).click()
    const form = page.getByRole('form', { name: 'Add a check' })
    const add = form.getByRole('button', { name: 'Add check' })
    log('a check needs its name and when it was last done', await add.isDisabled())
    await form.getByLabel('What it is').fill('Gas check')
    await form.getByLabel('Every (months)').fill('0')
    await form.getByLabel('Last done').fill('2025-03-15')
    log('…and every 1 to 120 months', await add.isDisabled())
    await form.getByLabel('Every (months)').fill('24')
    await add.click()
    log('added, it shows when it\'s next due', await until(async () => /Gas checkDue 15 March 2027 · last done 15 March 2025/.test(await smith().textContent())))
    const sent = calls('/rest/v1/compliance_items', 'POST')[0]?.body ?? {}
    log('…sent as the account\'s own check at that property',
      sent.team_id === TEAM && sent.location_id === 'loc-a' && sent.obligation === 'own:gas-check' && sent.label === 'Gas check' && sent.interval_months === 24 && sent.last_done_on === '2025-03-15', JSON.stringify(sent))
    await smith().getByRole('button', { name: 'Add a check at 10 Smith St, Toowong QLD 4066' }).click()
    await form.getByLabel('What it is').fill(' gas CHECK ')
    await form.getByLabel('Last done').fill('2025-01-01')
    await form.getByRole('button', { name: 'Add check' }).click()
    log('the same check twice is refused in words', await until(async () => /already has a check called "gas CHECK"/.test(await smith().textContent())))
    await form.getByRole('button', { name: 'Cancel' }).click()

    // Done again.
    await smith().getByRole('button', { name: 'Record Gas check as done' }).click()
    await smith().getByLabel('When Gas check was done').fill('2026-11-01')
    await smith().getByRole('button', { name: 'Save', exact: true }).click()
    log('done again, it moves on', await until(async () => /Gas checkDue 1 November 2028 · last done 1 November 2026/.test(await smith().textContent())))
    log('…saving just the date it was done', JSON.stringify(calls('/rest/v1/compliance_items', 'PATCH').at(-1)?.body) === '{"last_done_on":"2026-11-01"}' && /id=eq\.i-own-1/.test(calls('/rest/v1/compliance_items', 'PATCH').at(-1)?.search ?? ''))

    // Certificates.
    const pick = (name, mimeType, size = 2000) => smith().getByLabel('Certificate for Gas check', { exact: true }).setInputFiles({ name, mimeType, buffer: Buffer.alloc(size, 37) })
    await pick('notes.txt', 'text/plain')
    log('a file that isn\'t a PDF or photo is refused, and nothing sent', await until(async () => /has to be a PDF or a photo/.test(await smith().textContent())) && calls('/storage/v1/object/evidence/' , 'POST').length === 0)
    await pick('big.pdf', 'application/pdf', 10 * 1024 * 1024 + 1)
    log('…nor one over 10 MB', await until(async () => /over 10 MB/.test(await smith().textContent())))
    await pick('gas-2026.pdf', 'application/pdf')
    log('a PDF certificate is kept', await until(async () => (await smith().getByRole('button', { name: 'Open the certificate for Gas check' }).count()) === 1))
    const up = server.calls.find(c => c.method === 'POST' && c.path.startsWith('/storage/v1/object/evidence/'))
    const path = up?.path.slice('/storage/v1/object/evidence/'.length)
    log('…in the account\'s own folder, under the check', new RegExp(`^${TEAM}/checks/i-own-1/[0-9a-f-]{36}\\.pdf$`).test(path ?? ''), path)
    log('…and the check names it', calls('/rest/v1/compliance_items', 'PATCH').at(-1)?.body?.evidence_path === path)
    const popup = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null)
    await smith().getByRole('button', { name: 'Open the certificate for Gas check' }).click()
    const tab = await popup
    if (tab) await until(async () => tab.url().includes('token=cert'))
    log('"Certificate" opens it', (tab?.url() ?? '').endsWith(`/object/sign/evidence/${path}?token=cert`), tab?.url())
    await tab?.close()
    await smith().getByLabel('Certificate for Gas check', { exact: true }).setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(3000, 1) })
    await until(async () => server.calls.filter(c => c.method === 'POST' && c.path.startsWith('/storage/v1/object/evidence/')).length === 2)
    await until(async () => calls('/storage/v1/object/evidence', 'DELETE').length === 1)
    log('replacing it with a photo takes the old file away', JSON.stringify(calls('/storage/v1/object/evidence', 'DELETE')[0]?.body?.prefixes) === JSON.stringify([path]))
    server.uploadRefused = true
    await pick('again.pdf', 'application/pdf')
    log('a refusal from the bucket says certificates are Pro\'s', await until(async () => /Keeping certificates here is part of Pro/.test(await smith().textContent())))
    server.uploadRefused = false
    await page.screenshot({ path: `${DIR}/landlord-checks.png`, fullPage: true })

    // Removing it.
    const certNow = server.items.find(i => i.id === 'i-own-1')?.evidence_path
    await smith().getByRole('button', { name: 'Remove' }).click()
    const ask = page.getByRole('dialog')
    log('removing asks first, saying the certificate goes too', /Remove Gas check\?/.test(await ask.textContent()) && /its certificate goes with it/.test(await ask.textContent()))
    await ask.getByRole('button', { name: 'Remove' }).click()
    log('…then it\'s gone', await until(async () => !/Gas check/.test(await smith().textContent())))
    log('…only ever a check entered by hand, and its certificate with it',
      /obligation=like\.own:%/.test(calls('/rest/v1/compliance_items', 'DELETE')[0]?.search ?? '') && JSON.stringify(calls('/storage/v1/object/evidence', 'DELETE').at(-1)?.body?.prefixes) === JSON.stringify([certNow]))

    // Free with limits on.
    server.items.push({ id: 'i-own-9', location_id: 'loc-a', obligation: 'own:pool', label: 'Pool barrier', interval_months: 36, last_done_on: '2025-01-01', next_due_on: '2028-01-01', evidence_path: null, active: true })
    await open('#/properties', { ...FREE, enforced: true })
    await until(async () => /Pool barrier/.test(await main()))
    log('on Free with limits on, a certificate says it\'s Pro\'s, with no way to add one',
      /Keeping its certificate here is part of Pro/.test(await smith().textContent()) && (await smith().getByLabel('Certificate for Pool barrier', { exact: true }).count()) === 0)
    log('…while the check itself is still the landlord\'s to keep', (await smith().getByRole('button', { name: 'Record Pool barrier as done' }).count()) === 1)

    // The Due page.
    await open('#/due')
    log('the Due page lists the landlord\'s checks', await until(async () => /Gas check/.test(await main()) && /Smoke alarm safety check/.test(await main())))
    log('…asked for by the account', JSON.parse(JSON.stringify(calls('/rest/v1/rpc/due_list').at(-1)?.body ?? {})).p_team_id === TEAM)
    log('…filtered by owner, not client', (await page.getByRole('combobox').count()) === 1 && /Owner/.test(await main()) && /All owners/.test(await main()) && !/All clients/.test(await main()))
    log('…with no reminder switches', (await page.getByRole('checkbox').count()) === 0 && !/Reminders/.test(await main()))
    await page.screenshot({ path: `${DIR}/landlord-due.png`, fullPage: true })
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
