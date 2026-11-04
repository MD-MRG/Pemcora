/**
 * Step C5b: the signed-in devices on the Account card.
 *
 * The rules in Node first, then in a browser: the list put on the page by itself
 * (it only renders with a real login), and api.js's calls against the answers the
 * database gives. Every request off this machine is answered here or refused:
 * nothing reaches the live project. tests/devices-e2e.mjs does it for real.
 *
 *   node tests/devices.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - each login named from its browser details, "This device" on the one in use
 *   - any other can be signed out, after asking and naming it; so can all of them
 *   - before 0010 is applied, only "Sign out all other devices"
 *   - with no signal, nothing to sign out
 *   - no IP address or token is asked for or shown
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'
const localhost = new URL(BASE).hostname

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// ── The rules ───────────────────────────────────────────────────────────────
const { deviceName, sessionIdOf, thisDeviceFirst } = await import('../src/lib/devices.js')

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ipadChrome: 'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
}
log('an iPhone\'s Safari', deviceName(UA.iphone) === 'Safari on iPhone', deviceName(UA.iphone))
log('Edge on Windows, though it also says Chrome and Safari', deviceName(UA.edge) === 'Edge on Windows', deviceName(UA.edge))
log('Chrome on a Mac, and on an iPad', deviceName(UA.chromeMac) === 'Chrome on Mac' && deviceName(UA.ipadChrome) === 'Chrome on iPad')
log('Samsung\'s browser on Android, and Firefox on Linux',
  deviceName(UA.samsung) === 'Samsung Internet on Android' && deviceName(UA.firefox) === 'Firefox on Linux')
log('something it can\'t tell says so', deviceName('') === 'An unknown device' && deviceName('curl/8.0') === 'An unknown device')

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const token = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u', session_id: 'ses-1' })}.sig`
log('this device is found from its own login token', sessionIdOf(token) === 'ses-1')
log('anything else finds nothing', sessionIdOf('nonsense') === null && sessionIdOf(undefined) === null && sessionIdOf('a.b.c') === null)
log('this device comes first', thisDeviceFirst([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'b').map(d => d.id).join() === 'b,a,c')

// ── The screens ─────────────────────────────────────────────────────────────
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const db = { calls: [], missing: false, refuse: false }
async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
  db.calls.push({ path: url.pathname, body: req.postData() })
  if (url.pathname === '/rest/v1/rpc/my_devices') {
    if (db.missing) return json(404, { code: 'PGRST202', message: 'Could not find the function public.my_devices', hint: null, details: null })
    return json(200, [
      { id: 's1', user_agent: UA.iphone, signed_in_at: '2026-11-01T01:00:00+00:00', last_used_at: '2026-11-04T01:00:00+00:00' },
    ])
  }
  if (url.pathname === '/rest/v1/rpc/end_device') {
    if (db.refuse) return json(400, { code: 'P0002', message: 'That device is already signed out, or isn\'t one of yours', hint: 'not_yours', details: null })
    return route.fulfill({ status: 204, headers: cors })
  }
  return route.abort()
}

const DEVICES = [
  { id: 'other', userAgent: UA.iphone, signedInAt: '2026-10-01T01:00:00Z', lastUsedAt: '2026-11-03T22:00:00Z' },
  { id: 'mine', userAgent: UA.edge, signedInAt: '2026-11-04T00:00:00Z', lastUsedAt: '2026-11-04T01:00:00Z' },
  { id: 'old', userAgent: UA.samsung, signedInAt: '2026-08-01T01:00:00Z', lastUsedAt: '2026-09-01T01:00:00Z' },
]

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1000, height: 900 } })
  await ctx.route('**/*', backend)
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const mount = (props, opts) =>
    page.evaluate(async ([props, opts]) => (await import('/tests/fixtures/mount-devices.jsx')).mountDevices(props, opts), [props, opts])
  const region = () => page.getByRole('region', { name: 'Signed-in devices' })
  const calls = () => page.evaluate(() => window.__deviceCalls)
  const dialog = () => page.getByRole('dialog')

  // The list.
  await mount({ devices: DEVICES, currentId: 'mine', offline: false })
  const rows = await region().locator('li').allTextContents()
  log('each login is named from its browser details, this device first',
    /^Edge on WindowsThis device/.test(rows[0]) && /^Safari on iPhone/.test(rows[1]) && /^Samsung Internet on Android/.test(rows[2]), rows.join(' | '))
  log('with when it signed in and was last used', /Signed in .* · last used /.test(rows[1]))
  log('this device has no Sign out of its own: that\'s the Sign out above',
    (await region().locator('li').first().getByRole('button').count()) === 0 && (await region().getByRole('button', { name: /^Sign out .*, last used / }).count()) === 2)
  await page.screenshot({ path: `${DIR}/devices-list.png` })

  // One signed out.
  await region().getByRole('button', { name: /^Sign out Safari on iPhone/ }).click()
  log('signing one out asks first, naming it', (await dialog().getAttribute('aria-label')) === 'Sign out Safari on iPhone?' && /last used/.test(await dialog().textContent()))
  await dialog().getByRole('button', { name: 'Keep it signed in' }).click()
  log('and keeping it does nothing', (await calls()).length === 0)
  await region().getByRole('button', { name: /^Sign out Safari on iPhone/ }).click()
  await dialog().getByRole('button', { name: 'Sign it out' }).click()
  log('signing it out ends that login', JSON.stringify(await calls()) === '[["end","other"]]')
  log('and says what it means', /Safari on iPhone is signed out\. It can't renew its login, which runs out within the hour\./.test(await region().getByRole('status').textContent()))

  // All of them.
  await region().getByRole('button', { name: 'Sign out all other devices' }).click()
  log('signing out all the others asks first', (await dialog().getAttribute('aria-label')) === 'Sign out all your other devices?')
  await dialog().getByRole('button', { name: 'Sign them out' }).click()
  log('and ends every login but this one', JSON.stringify((await calls()).at(-1)) === '["others"]')

  // Refused.
  await mount({ devices: DEVICES, currentId: 'mine', offline: false }, { fail: 'That device is already signed out, or isn\'t one of yours' })
  await region().getByRole('button', { name: /^Sign out Samsung/ }).click()
  await dialog().getByRole('button', { name: 'Sign it out' }).click()
  log('a refusal is said', /already signed out, or isn't one of yours/.test(await region().getByRole('alert').textContent()))

  // Only this device; before 0010; offline.
  await mount({ devices: [DEVICES[1]], currentId: 'mine', offline: false })
  log('with only this device there\'s nothing else to sign out', (await region().getByRole('button').count()) === 0)
  await mount({ devices: null, currentId: 'mine', offline: false })
  log('before 0010, only "Sign out all other devices"',
    /comes with an update/.test(await region().textContent()) && (await region().getByRole('button').allTextContents()).join() === 'Sign out all other devices')
  // A list loaded before the signal went: still nothing to sign out.
  await mount({ devices: DEVICES, currentId: 'mine', offline: true })
  log('with no signal, it says it needs a connection, and offers nothing',
    /needs a connection/.test(await region().textContent()) && (await region().getByRole('button').count()) === 0)
  log('it says what signing out can\'t do', /up to an hour/.test(await region().textContent()) && /never connects again keeps what it already holds/.test(await region().textContent()))

  // The database calls.
  const call = (method, args = []) =>
    page.evaluate(async ({ method, args }) => {
      const api = await import('/src/lib/api.js')
      try {
        return { data: await api[method](...args) }
      } catch (e) {
        return { error: { message: e.message, code: e.code, hint: e.hint } }
      }
    }, { method, args })
  const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
  if (!configured) {
    console.log('(the database call checks need VITE_SUPABASE_URL in .env, and were skipped)')
  } else {
    let out = await call('listMyDevices')
    log('the list is asked of my_devices(), in the app\'s shape',
      out.data?.[0]?.id === 's1' && out.data[0].userAgent === UA.iphone && out.data[0].lastUsedAt && !('ip' in out.data[0]), JSON.stringify(out))
    db.missing = true
    out = await call('listMyDevices')
    log('before 0010 it answers null, not an error', out.data === null && !out.error, JSON.stringify(out))
    db.missing = false
    out = await call('endDevice', ['s9'])
    log('ending one sends only its id', !out.error && db.calls.at(-1).body === '{"p_session_id":"s9"}', db.calls.at(-1).body)
    db.refuse = true
    out = await call('endDevice', ['s9'])
    log('and a refusal comes back with its code', out.error?.code === 'P0002' && out.error.hint === 'not_yours', JSON.stringify(out.error))
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
