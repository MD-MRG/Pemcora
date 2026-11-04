// Signed-in devices against the real project (build plan C5).
//
//   node tests/devices-e2e.mjs <email> <password>
//
// tests/devices.mjs and tests/offline-open.mjs prove the app's side against
// stand-ins, and the SQL suite proves 0010 on a local Postgres. This proves the
// real Auth server agrees: logins made with a password, listed by my_devices(),
// ended by end_device() and by "Sign out all other devices", and an ended one
// refused when it tries to renew while the others still can. Then the app itself,
// in a browser, finding its login was ended from another device.
//
// SIGNS IN TO THE LIVE PROJECT, so nothing runs it automatically. It needs 0010
// applied, the dev server on 5173, and a confirmed account: use a test account.
// It makes no team and changes no data. Every login it makes is ended by the time
// it finishes. It never prints the password or a token.

import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { createClient } from '@supabase/supabase-js'
import { sessionIdOf } from '../src/lib/devices.js'

const BASE = 'http://localhost:5173/'
const [EMAIL, PASSWORD] = process.argv.slice(2)
if (!EMAIL || !PASSWORD) {
  console.error('Usage: node tests/devices-e2e.mjs <email> <password>  (a confirmed test account)')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const PROJECT_REF = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]
const AUTH_KEY = `sb-${PROJECT_REF}-auth-token`

let failures = 0
const log = (ok, name, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(200)
  }
  return false
}

// A login of its own, as a separate device would have.
async function login(name) {
  const client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  if (error) {
    console.error(`FAIL  could not sign in as ${name}: ${error.message}`)
    process.exit(1)
  }
  return { client, name, id: sessionIdOf(data.session.access_token) }
}
// Whether a login can still renew, and if not, the Auth server's own code.
async function renews(device) {
  const { error } = await device.client.auth.refreshSession()
  return error ? { ok: false, code: error.code ?? null } : { ok: true }
}
const listed = async device => {
  const { data, error } = await device.client.rpc('my_devices')
  if (error) throw error
  return data
}

const phone = await login('phone')
const laptop = await login('laptop')

let browser = null
try {
  // ── 0010 is there ─────────────────────────────────────────────────────────
  const first = await phone.client.rpc('my_devices')
  if (first.error?.code === 'PGRST202') {
    console.error('FAIL  my_devices() is missing: apply supabase/migrations/0010_signed_in_devices.sql first')
    process.exit(1)
  }
  log(!first.error, 'my_devices() answers', first.error?.message)

  // ── The list ──────────────────────────────────────────────────────────────
  let rows = await listed(phone)
  const ids = rows.map(r => r.id)
  log(ids.includes(phone.id) && ids.includes(laptop.id), 'each login is listed, both of them', `${rows.length} logins`)
  log(rows.every(r => Object.keys(r).sort().join() === 'id,last_used_at,signed_in_at,user_agent'), 'with only its id, browser details and times: no IP address, no token')
  log(rows.every(r => r.signed_in_at && r.last_used_at), 'each with when it signed in and was last used')

  // ── One ended from another ────────────────────────────────────────────────
  const { error: endError } = await phone.client.rpc('end_device', { p_session_id: laptop.id })
  log(!endError, 'the phone ends the laptop\'s login', endError?.message)
  const laptopNow = await renews(laptop)
  log(!laptopNow.ok && ['refresh_token_not_found', 'session_not_found'].includes(laptopNow.code),
    'the laptop can\'t renew, and the Auth server says its login is gone', laptopNow.code ?? 'it renewed')
  log((await renews(phone)).ok, 'while the phone still can')
  rows = await listed(phone)
  log(!rows.some(r => r.id === laptop.id) && rows.some(r => r.id === phone.id), 'and the laptop is gone from the list')
  const again = await phone.client.rpc('end_device', { p_session_id: laptop.id })
  log(again.error?.code === 'P0002', 'ending it again is refused, as someone else\'s would be', again.error?.code)

  // ── Everything else, at once ──────────────────────────────────────────────
  const tablet = await login('tablet')
  const pc = await login('pc')
  const { error: othersError } = await phone.client.auth.signOut({ scope: 'others' })
  log(!othersError, '"Sign out all other devices" goes through', othersError?.message)
  const [tabletNow, pcNow, phoneNow] = [await renews(tablet), await renews(pc), await renews(phone)]
  log(!tabletNow.ok && !pcNow.ok, 'every other login is ended', `${tabletNow.code}, ${pcNow.code}`)
  log(phoneNow.ok, 'and the one that asked still renews')

  // ── The app, finding it was signed out elsewhere ──────────────────────────
  browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }))
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  log(await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 0), 'the app signs in')
  const appId = await page.evaluate(key => {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null')
    return stored?.access_token ?? null
  }, AUTH_KEY).then(sessionIdOf)
  rows = await listed(phone)
  log(rows.some(r => r.id === appId), 'its login appears in the list')
  const { error: appEndError } = await phone.client.rpc('end_device', { p_session_id: appId })
  log(!appEndError, 'the phone ends the app\'s login', appEndError?.message)
  // Its token runs out, and it asks to renew, as it would within the hour.
  await page.evaluate(key => {
    const stored = JSON.parse(localStorage.getItem(key))
    localStorage.setItem(key, JSON.stringify({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 60 }))
    window.dispatchEvent(new Event('online'))
  }, AUTH_KEY)
  log(await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 1), 'the app goes to the sign-in screen')
  log(/signed out from another device/.test(await page.textContent('body')), 'saying it was signed out from another device')
  log((await page.evaluate(() => localStorage.getItem('fc.session.user'))) === null, 'and forgets who was signed in')
  await ctx.close()
} catch (e) {
  log(false, 'the run threw before finishing', e.message)
} finally {
  // Every login this run made is ended: the phone's last, by signing it out.
  await phone.client.auth.signOut({ scope: 'local' }).catch(() => {})
  await browser?.close()
  console.log(failures ? `\n${failures} failed` : '\nAll passed')
  process.exit(failures ? 1 : 0)
}
