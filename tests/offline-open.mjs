/**
 * Opening the app with no signal (build plan B3b).
 *
 * Only a production build has a service worker, so this builds one and serves it. It
 * builds with a backend address that doesn't exist, so nothing here can reach the
 * live project, and every request to the database simply fails, as it does on a site
 * with no signal. The build goes under node_modules/.cache and doesn't touch dist/.
 *
 * What it holds the app to:
 *   - with no connection, a device that has been here before opens, at any time,
 *     even with its login token expired
 *   - it runs on what the device holds, and a visit can be worked and reported on
 *   - a reload changes nothing
 *   - the service worker keeps the app's own files and nothing else
 *   - with a connection, the main page comes from the network, so a deploy gets through
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'node_modules', '.cache', 'pemcora-offline-open')
const PORT = 4179
// Under a sub-path, as GitHub Pages serves it, since a service worker's scope and
// file list depend on where it lives.
const BASE = `http://localhost:${PORT}/Pemcora/`
const BACKEND = 'https://pemcora-test.invalid'
const AUTH_KEY = 'sb-pemcora-test-auth-token'

const log = (k, v, extra = '') =>
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const env = { ...process.env, VITE_SUPABASE_URL: BACKEND, VITE_SUPABASE_ANON_KEY: 'test-key' }

rmSync(OUT, { recursive: true, force: true })
const built = spawnSync(process.execPath, [vite, 'build', '--outDir', OUT, '--emptyOutDir', '--logLevel', 'error'], {
  cwd: ROOT,
  env,
  encoding: 'utf8',
})
log('the app builds', built.status === 0, built.stderr?.slice(0, 300))

const sw = readFileSync(join(OUT, 'sw.js'), 'utf8')
const files = JSON.parse(sw.match(/const FILES = (\[.*\])/)[1])
log('the service worker is told which files make up this build',
  files.includes('index.html') && files.some(f => /^assets\/index-.*\.js$/.test(f)) && files.some(f => /exceljs/.test(f)) && files.includes('favicon.svg'),
  files.join(', ').slice(0, 200))
log('with nothing left unfilled', !/__FILES__|__BUILD__/.test(sw))
log('and no secrets or addresses in it', !/supabase|test-key|invalid/i.test(sw.replace(/^\/\/.*$/gm, '')))

const server = spawn(process.execPath, [vite, 'preview', '--outDir', OUT, '--base', '/Pemcora/', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  env,
  stdio: 'ignore',
})
const reachable = await until(async () => {
  try {
    return (await fetch(BASE)).ok
  } catch {
    return false
  }
})
log('the build is being served', reachable)

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}
const browser = await launch()

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'sam@example.com' }
const TEAM = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Northpoint',
  description: '',
  inviteCode: 'x',
  role: 'member',
  memberCount: 1,
  adminCount: 1,
}
const CLIENTS = [
  {
    id: 'c1',
    name: 'Equinix',
    locations: [
      {
        id: 'l1',
        address: '8 Grand Avenue',
        suburb: 'Rosehill',
        floors: [{ id: 'f1', label: 'Ground', position: 0, rooms: [{ id: 'r1', name: 'Reception', position: 0 }] }],
        visits: [],
      },
    ],
  },
]

// A device that has been here before: an expired login, the last team, a device copy,
// and with `unsaved`, a second tab's copy holding work the team doesn't have yet.
async function hasBeenHere(page, { copy = true, unsaved = false } = {}) {
  await page.evaluate(
    async ({ AUTH_KEY, USER, TEAM, CLIENTS, copy, unsaved }) => {
      localStorage.setItem(
        AUTH_KEY,
        JSON.stringify({
          access_token: 'expired',
          refresh_token: 'refresh',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) - 7200,
          user: USER,
        }),
      )
      localStorage.setItem('fc.session.user', JSON.stringify(USER))
      localStorage.setItem('fc.session.teams', JSON.stringify({ userId: USER.id, teams: [TEAM] }))
      if (!copy) return
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open('pemcora-offline', 1)
        open.onupgradeneeded = () => open.result.createObjectStore('copies', { keyPath: 'id' })
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
      })
      await new Promise(resolve => {
        const tx = db.transaction('copies', 'readwrite')
        const data = { clients: CLIENTS, settings: null, templates: {} }
        tx.objectStore('copies').put({
          id: `${USER.id}:${TEAM.id}:old-tab`,
          userId: USER.id,
          teamId: TEAM.id,
          data,
          snapshot: data,
          held: {},
          unsaved: false,
          savedAt: new Date().toISOString(),
        })
        if (unsaved) {
          const mine = { ...data, clients: [{ ...CLIENTS[0], name: 'Equinix (renamed here)' }] }
          tx.objectStore('copies').put({
            id: `${USER.id}:${TEAM.id}:unsaved-tab`,
            userId: USER.id,
            teamId: TEAM.id,
            data: mine,
            snapshot: data,
            held: {},
            unsaved: true,
            savedAt: new Date().toISOString(),
          })
        }
        tx.oncomplete = resolve
      })
      db.close()
    },
    { AUTH_KEY, USER, TEAM, CLIENTS, copy, unsaved },
  )
}

// The device copies left, by id.
const copiesLeft = page =>
  page.evaluate(
    () =>
      new Promise(resolve => {
        const open = indexedDB.open('pemcora-offline')
        open.onsuccess = () => {
          const all = open.result.transaction('copies').objectStore('copies').getAllKeys()
          all.onsuccess = () => resolve(all.result.map(String).sort())
        }
      }),
  )

const pageErrors = []
async function newDevice() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(BASE, { waitUntil: 'load' })
  const ready = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
    }
    return !!registration.active
  })
  return { ctx, page, ready }
}

try {
  // ── A first visit ─────────────────────────────────────────────────────────
  {
    const { ctx, page, ready } = await newDevice()
    log('a first visit installs the service worker', ready)
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys()
      const urls = []
      for (const key of keys) {
        for (const request of await (await caches.open(key)).keys()) urls.push(request.url)
      }
      return { keys, urls }
    })
    log('it holds every file of the build',
      files.every(f => cached.urls.some(u => u.endsWith(`/${f}`))), `${cached.urls.length} of ${files.length}`)
    log('and only the app\'s own files', cached.urls.every(u => u.startsWith(BASE)), cached.urls.find(u => !u.startsWith(BASE)) ?? '')

    // ── Never been signed in here ───────────────────────────────────────────
    await ctx.setOffline(true)
    await page.reload({ waitUntil: 'load' })
    log('with no connection the app still opens', await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 1))
    log('and with nobody remembered, it asks for a sign-in', (await page.locator('nav a').count()) === 0)
    await ctx.close()
  }

  // ── A device that has been here before ────────────────────────────────────
  {
    const { ctx, page } = await newDevice()
    await hasBeenHere(page)
    await ctx.setOffline(true)
    await page.reload({ waitUntil: 'load' })

    log('with no connection and an expired login, it opens anyway', await until(async () => (await page.locator('nav a').count()) >= 7))
    log('with no sign-in screen in the way', (await page.getByRole('heading', { name: /sign in/i }).count()) === 0)
    log('showing what the device holds', await until(async () => /Equinix/.test(await page.textContent('main')) || /Clients1/.test(await page.textContent('main'))))
    const statusLine = () => page.locator('div.text-right[role="status"]').textContent()
    log('and saying it is offline', /^Offline: changes are kept on this device$/.test((await statusLine()).trim()), await statusLine())

    // A visit, start to report, with no connection at any point.
    await page.locator('nav a').filter({ hasText: 'Preventative Maintenance' }).click()
    await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
    await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
    await page.getByRole('button', { name: /^Start PM$/ }).click()
    log('a visit can be started', await until(async () => (await page.getByRole('button', { name: /^Continue$/ }).count()) === 1))
    await page.getByRole('button', { name: /^Reception/ }).click()
    await page.getByRole('button', { name: 'Correct Time and Date: PASS', exact: true }).click()
    await sleep(300)
    log('and answered', (await page.getByRole('button', { name: 'Correct Time and Date: PASS', exact: true }).getAttribute('aria-pressed')) === 'true')

    await page.reload({ waitUntil: 'load' })
    await until(async () => (await page.locator('nav a').count()) >= 7)
    await page.locator('nav a').filter({ hasText: 'Preventative Maintenance' }).click()
    await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
    await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
    await page.getByRole('button', { name: /^Reception/ }).click()
    log('a reload with no connection keeps it',
      (await page.getByRole('button', { name: 'Correct Time and Date: PASS', exact: true }).getAttribute('aria-pressed')) === 'true')

    await page.getByRole('button', { name: /← ?Back|^Back/ }).first().click()
    const download = page.waitForEvent('download', { timeout: 20000 })
    await page.getByRole('button', { name: 'Export report' }).click()
    log('and the Excel report works too, its library having been kept', /\.xlsx$/.test((await download).suggestedFilename()))

    // Signing out still has to work, with an expired token and nothing to talk to.
    await page.locator('nav a').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    log('signing out with unsaved work asks first',
      await until(async () => /isn't saved yet/.test(await page.getByRole('dialog').textContent().catch(() => ''))))
    await page.getByRole('button', { name: 'Discard it and sign out' }).click()
    log('and works with no connection', await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 1))
    const left = await page.evaluate(
      async key => ({
        token: localStorage.getItem(key),
        user: localStorage.getItem('fc.session.user'),
        teams: localStorage.getItem('fc.session.teams'),
        copies: await new Promise(resolve => {
          const open = indexedDB.open('pemcora-offline')
          open.onsuccess = () => {
            const all = open.result.transaction('copies').objectStore('copies').getAll()
            all.onsuccess = () => resolve(all.result.length)
          }
        }),
      }),
      AUTH_KEY,
    )
    log('leaving nothing of theirs behind', !left.token && !left.user && !left.teams && left.copies === 0, JSON.stringify(left))
    await page.reload({ waitUntil: 'load' })
    log('so a reload stays at the sign-in screen', await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 1))
    await ctx.close()
  }

  // ── Staying open ──────────────────────────────────────────────────────────
  {
    // The login library keeps trying to renew the token for about half a minute,
    // then reports "no session". That is not the same as being signed out.
    const { ctx, page } = await newDevice()
    await hasBeenHere(page)
    await ctx.setOffline(true)
    await page.reload({ waitUntil: 'load' })
    await until(async () => (await page.locator('nav a').count()) >= 7)
    const thrownOut = await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 1, 40000)
    log('it stays open while the login keeps failing to renew', !thrownOut)
    log('still showing the work', (await page.locator('nav a').count()) >= 7)
    await ctx.close()
  }

  // ── Signal that goes nowhere ──────────────────────────────────────────────
  {
    // The device thinks it's online, but nothing answers.
    const { ctx, page } = await newDevice()
    await hasBeenHere(page)
    const before = Date.now()
    await page.reload({ waitUntil: 'load' })
    log('when the network goes nowhere it still opens', await until(async () => (await page.locator('nav a').count()) >= 7, 20000), `${Date.now() - before} ms`)
    log('on what the device holds', await until(async () => /Clients1/.test(await page.textContent('main'))))
    log('saying it is offline, not failed',
      await until(async () => /^Offline/.test((await page.locator('div.text-right[role="status"]').textContent()).trim())))
    await ctx.close()
  }

  // ── Signed out from another device (step C5c) ─────────────────────────────
  // The Auth server refuses to renew the login. With the code that says the login
  // no longer exists, the device was signed out elsewhere: what the team has goes,
  // what only this device has stays (D12). Any other refusal is just a sign-out.
  // `midway`: the app is already open when its renewal is refused, rather than
  // opening with a login that has been ended.
  for (const [code, ended, midway] of [
    ['refresh_token_not_found', true, false],
    ['refresh_token_already_used', false, false],
    ['session_not_found', true, true],
  ]) {
    const { ctx, page } = await newDevice()
    await hasBeenHere(page, { unsaved: true })
    const expiresAt = when =>
      page.evaluate(
        ([key, at]) => {
          const stored = JSON.parse(localStorage.getItem(key))
          localStorage.setItem(key, JSON.stringify({ ...stored, expires_at: at }))
        },
        [AUTH_KEY, when],
      )
    if (midway) await expiresAt(Math.floor(Date.now() / 1000) + 3600)
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
    await ctx.route(`${BACKEND}/**`, route => {
      const url = route.request().url()
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      if (/\/auth\/v1\/token\?grant_type=refresh_token/.test(url)) {
        // The same message either way: only the code tells them apart.
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          headers: cors,
          body: JSON.stringify({ code: 400, error_code: code, msg: 'Invalid Refresh Token: Refresh Token Not Found' }),
        })
      }
      return route.abort()
    })
    await page.reload({ waitUntil: 'load' })
    if (midway) {
      log('a device with a login still good opens as usual', await until(async () => (await page.locator('nav a').count()) >= 7, 20000))
      // Its token runs out, and coming back online it asks to renew it.
      await expiresAt(Math.floor(Date.now() / 1000) - 60)
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
    }
    const signIn = await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 1, 20000)
    const said = /signed out from another device/.test(await page.textContent('body'))
    await until(async () => (await copiesLeft(page)).length < 2, ended ? 5000 : 1000)
    const left = await copiesLeft(page)
    const session = await page.evaluate(() => ({ user: localStorage.getItem('fc.session.user'), teams: localStorage.getItem('fc.session.teams') }))
    if (ended && midway) {
      log('one already open, finding its login was ended, goes to the sign-in screen too', signIn)
      log('saying so', said)
      // Open, it gathered the other tab's unsent work into its own copy.
      const kept = await page.evaluate(
        () =>
          new Promise(resolve => {
            const open = indexedDB.open('pemcora-offline')
            open.onsuccess = () => {
              const all = open.result.transaction('copies').objectStore('copies').getAll()
              all.onsuccess = () => resolve(all.result.map(c => ({ unsaved: c.unsaved || Object.keys(c.held ?? {}).length > 0, name: c.data?.clients?.[0]?.name })))
            }
          }),
      )
      log('keeping only what exists nowhere else',
        !left.some(id => id.endsWith(':old-tab')) && kept.length > 0 && kept.every(c => c.unsaved) && kept.some(c => c.name === 'Equinix (renamed here)'),
        JSON.stringify(kept))
    } else if (ended) {
      log('a device whose login was ended elsewhere goes to the sign-in screen', signIn)
      log('which says it was signed out from another device', said)
      log('what the team already had is wiped from it', !left.some(id => id.endsWith(':old-tab')), left.join(', '))
      log('but work that exists nowhere else stays, for the next sign-in here', left.some(id => id.endsWith(':unsaved-tab')))
      log('and who was signed in here goes', !session.user && !session.teams)
      await page.screenshot({ path: join(OUT, '..', 'ended-elsewhere.png') }).catch(() => {})
    } else {
      log('another refusal, with the same message, is a plain sign-out', signIn && !said)
      log('which wipes nothing', left.length === 2, left.join(', '))
    }
    await ctx.close()
  }

  // ── What the team has (step B4) ───────────────────────────────────────────
  {
    // A login that is still good, so the app asks the database as it would online.
    // Only these two requests get an answer. The data comes from the device, unless
    // this is about what shows while the plan is still on its way.
    const answering = async (ctx, entitlements, { data = false } = {}) => {
      await ctx.unroute(`${BACKEND}/**`)
      await ctx.route(`${BACKEND}/**`, route => {
        const { pathname } = new URL(route.request().url())
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        const respond = (status, body) =>
          route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
        if (pathname.endsWith('/my_teams')) {
          return respond(200, [{ team_id: TEAM.id, name: TEAM.name, description: '', invite_code: 'x', role: 'member', member_count: 1, admin_count: 1 }])
        }
        if (pathname.endsWith('/team_entitlements')) return entitlements(respond)
        if (data && route.request().method() === 'GET') {
          return respond(200, pathname.endsWith('/team_settings') ? {} : [])
        }
        return route.abort()
      })
    }
    const navLabels = page => page.locator('nav[aria-label="Main"] a').allTextContents()
    const signedIn = page =>
      page.evaluate(
        ({ AUTH_KEY, USER }) =>
          localStorage.setItem(
            AUTH_KEY,
            JSON.stringify({
              access_token: 'good',
              refresh_token: 'refresh',
              token_type: 'bearer',
              expires_in: 3600,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: USER,
            }),
          ),
        { AUTH_KEY, USER },
      )
    const row = over => ({
      enforced: false, account_type: 'provider', plan: 'free', is_pro: false, seat_limit: 1, seats_used: 1,
      visit_limit: 1, visits_used: 0, packs: ['core', 'av'], past_due_until: null, cancel_at: null,
      import_used: false, open_visits: 0, ...over,
    })

    {
      // Without a pack, read through the real sign-in and DataBoot.
      const { ctx, page } = await newDevice()
      await hasBeenHere(page)
      await signedIn(page)
      await answering(ctx, respond => respond(200, row({ packs: ['core', 'vic_rental'] })))
      await page.reload({ waitUntil: 'load' })
      log('opening reads what the team has',
        await until(async () => {
          const labels = await navLabels(page)
          return labels.includes('Custom List') && !labels.includes('Preventative Maintenance')
        }), (await navLabels(page)).join(' | '))
      await page.goto(`${BASE}#/maintenance`)
      log('so a page it doesn\'t hold goes Home', await until(() => new URL(page.url()).hash === '#/'), page.url())

      await ctx.unroute(`${BACKEND}/**`)
      await ctx.setOffline(true)
      await page.reload({ waitUntil: 'load' })
      log('and with no connection the last answer still holds',
        await until(async () => {
          const labels = await navLabels(page)
          return labels.includes('Custom List') && !labels.includes('Preventative Maintenance')
        }), (await navLabels(page)).join(' | '))

      await answering(ctx, respond => respond(200, row()))
      await ctx.setOffline(false)
      log('and when the connection returns it asks again',
        await until(async () => (await navLabels(page)).includes('Preventative Maintenance')), (await navLabels(page)).join(' | '))
      await ctx.unroute(`${BACKEND}/**`)
      await ctx.setOffline(true)

      // A Due list kept on the device goes too (C4).
      await page.evaluate(() => localStorage.setItem('fc.session.due', JSON.stringify({ teamId: 't', at: 'x', rows: [] })))
      await page.locator('nav a').filter({ hasText: 'Settings' }).click()
      await page.getByRole('button', { name: 'Sign out' }).click()
      await until(async () => (await page.getByRole('dialog').count()) === 1)
      const leave = page.getByRole('dialog').getByRole('button', { name: /sign out/i }).last()
      await leave.click()
      await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 1)
      log('signing out leaves none of it behind, nor the Due list',
        (await page.evaluate(() => localStorage.getItem('fc.session.entitlements'))) === null &&
          (await page.evaluate(() => localStorage.getItem('fc.session.due'))) === null)
      await ctx.close()
    }
    {
      // Never seen this team's plan, and it's a landlord's.
      const { ctx, page } = await newDevice()
      await hasBeenHere(page)
      await signedIn(page)
      // The data arrives at once and the plan well after, so without the wait the app
      // would have a menu on screen before it knew whose.
      await answering(
        ctx,
        async respond => {
          await sleep(2000)
          return respond(200, row({ account_type: 'landlord', packs: ['core'] }))
        },
        { data: true },
      )
      // Watching from the moment the page starts, for the inspector's menu flashing up.
      await ctx.addInitScript(() => {
        window.__sawInspectorMenu = false
        new MutationObserver(() => {
          if (document.querySelector('nav[aria-label="Main"]')?.textContent.includes('New Client')) {
            window.__sawInspectorMenu = true
          }
        }).observe(document, { childList: true, subtree: true })
      })
      await page.reload({ waitUntil: 'load' })
      log('a landlord\'s first screen is its own',
        await until(async () => (await navLabels(page)).join() === 'Properties,Reports,Due,Settings'), (await navLabels(page)).join(' | '))
      log('on its properties', new URL(page.url()).hash === '#/properties', page.url())
      log('without an inspector\'s menu flashing up first',
        !(await page.evaluate(() => window.__sawInspectorMenu)))
      await ctx.close()
    }
    {
      // A new person, through the real sign-in, gate and team loading (step B5).
      const { ctx, page } = await newDevice()
      await hasBeenHere(page, { copy: false })
      await signedIn(page)
      await page.evaluate(() => localStorage.removeItem('fc.session.teams'))

      let teams = []
      let onCreate = route => route.abort()
      const creates = []
      const teamRow = { team_id: TEAM.id, name: "Sam's team", description: '', invite_code: 'x', role: 'owner', member_count: 1, admin_count: 1 }
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
      const reply = (route, status, body) =>
        route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
      await ctx.route(`${BACKEND}/**`, route => {
        const { pathname } = new URL(route.request().url())
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        if (pathname.endsWith('/my_teams')) return reply(route, 200, teams)
        if (pathname.endsWith('/team_entitlements')) return reply(route, 200, row({ starter_pack: 'av' }))
        if (pathname.endsWith('/create_organisation')) {
          creates.push(route.request().postDataJSON())
          return onCreate(route)
        }
        if (route.request().method() === 'GET') return reply(route, 200, pathname.endsWith('/team_settings') ? {} : [])
        return route.abort()
      })

      await page.reload({ waitUntil: 'load' })
      const avChoice = page.getByRole('radio', { name: /^AV integration/ })
      log('a new person is asked what their team does',
        await until(async () => (await avChoice.count()) === 1), (await page.textContent('body')).slice(0, 150))
      log('and no team has been made without asking', creates.length === 0)
      // Landlords and property managers opened at D4.
      log('with the checks that aren\'t ready marked as coming soon',
        await page.getByRole('radio', { name: /^Electrical work/ }).isDisabled() &&
        await page.getByRole('radio', { name: /^Landlord/ }).isEnabled() &&
        await page.getByRole('radio', { name: /^Property management/ }).isEnabled())
      log('and the sign-in screen no longer says AV Service', !/AV Service/i.test(await page.textContent('body')))

      await avChoice.check()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()

      // No connection, and nothing made: it says so and stays.
      await page.getByRole('button', { name: 'Create team', exact: true }).click()
      log('a failed attempt stays on the screen, and can be tried again',
        await until(async () => creates.length === 1 && await page.getByRole('button', { name: 'Create team', exact: true }).isEnabled()))
      log('saying something went wrong', (await page.locator('[role="status"]').count()) >= 1)
      log('asking for what they chose',
        JSON.stringify(creates[0]) === JSON.stringify({
          p_name: "Sam's team", p_account_type: 'provider', p_pack_id: 'av', p_description: '', p_state: null, p_addons: [],
        }), JSON.stringify(creates[0]))

      // Made, with only the answer lost: the app has to find it, not make another.
      onCreate = route => {
        teams = [teamRow]
        return route.abort()
      }
      await page.getByRole('button', { name: 'Create team', exact: true }).click()
      log('made with the answer lost, it finds the team and opens',
        await until(async () => (await page.locator('nav a').count()) >= 7), (await page.textContent('body')).slice(0, 150))
      log('without being asked to try again', creates.length === 2, `${creates.length}`)
      log('and the plate says what it does', /AV Service/i.test(await page.locator('span.uppercase').first().textContent()))
      await ctx.close()
    }
    {
      // An answer that does arrive, and a member who wasn't asked anything.
      const { ctx, page } = await newDevice()
      await hasBeenHere(page, { copy: false })
      await signedIn(page)
      await page.evaluate(() => localStorage.removeItem('fc.session.teams'))
      let teams = []
      const teamRow = { team_id: TEAM.id, name: "Sam's team", description: '', invite_code: 'x', role: 'owner', member_count: 1, admin_count: 1 }
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
      const reply = (route, status, body) =>
        route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
      await ctx.route(`${BACKEND}/**`, route => {
        const { pathname } = new URL(route.request().url())
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
        if (pathname.endsWith('/my_teams')) return reply(route, 200, teams)
        if (pathname.endsWith('/team_entitlements')) return reply(route, 200, row({ starter_pack: 'av' }))
        if (pathname.endsWith('/create_organisation')) {
          teams = [teamRow]
          return reply(route, 200, { id: TEAM.id, name: "Sam's team" })
        }
        if (route.request().method() === 'GET') return reply(route, 200, pathname.endsWith('/team_settings') ? {} : [])
        return route.abort()
      })
      await page.reload({ waitUntil: 'load' })
      await page.getByRole('radio', { name: /^AV integration/ }).check({ timeout: 15000 })
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Create team', exact: true }).click()
      log('confirming opens the app', await until(async () => (await page.locator('nav a').count()) >= 7))
      log('on Home, with its team', new URL(page.url()).hash === '#/' || new URL(page.url()).hash === '')
      await page.reload({ waitUntil: 'load' })
      log('and it\'s never asked again',
        await until(async () => (await page.locator('nav a').count()) >= 7) && (await page.getByRole('radio', { name: /^AV integration/ }).count()) === 0)
      await ctx.close()
    }
    {
      // A project without the function yet: today's AV app has to keep working.
      const { ctx, page } = await newDevice()
      await hasBeenHere(page)
      await signedIn(page)
      await answering(ctx, respond => respond(404, { code: 'PGRST202', message: 'Could not find the function', details: null, hint: null }))
      await page.reload({ waitUntil: 'load' })
      log('with no such function everything still opens',
        await until(async () => (await navLabels(page)).includes('Preventative Maintenance')),
        (await navLabels(page)).join(' | '))
      await ctx.close()
    }
    {
      // An answer that never comes must not hold the app up for long.
      const { ctx, page } = await newDevice()
      await hasBeenHere(page)
      await signedIn(page)
      let release
      const never = new Promise(resolve => (release = resolve))
      await answering(ctx, async respond => {
        await never
        return respond(200, row())
      })
      const began = Date.now()
      await page.reload({ waitUntil: 'load' })
      log('an answer that doesn\'t come holds it up only briefly',
        await until(async () => (await navLabels(page)).includes('Preventative Maintenance'), 12000), `${Date.now() - began} ms`)
      release()
      await ctx.close()
    }
    {
      // Signing out with a connection, through the real login library. The same person
      // may be mid-visit on a phone, so it ends this device's login and no other.
      const { ctx, page } = await newDevice()
      await hasBeenHere(page, { copy: false })
      await signedIn(page)
      await answering(ctx, respond => respond(200, row()), { data: true })
      const logouts = []
      await ctx.route(`${BACKEND}/auth/v1/logout*`, route => {
        if (route.request().method() === 'OPTIONS') return route.fallback()
        logouts.push(new URL(route.request().url()).searchParams.get('scope'))
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } })
      })
      await page.reload({ waitUntil: 'load' })
      await until(async () => (await page.locator('nav a').count()) >= 7)
      await page.locator('nav a').filter({ hasText: 'Settings' }).click()
      await page.getByRole('button', { name: 'Sign out' }).click()
      log('signing out says it is for this device',
        await until(async () => /other devices stay signed in/.test(await page.getByRole('dialog').textContent().catch(() => ''))))
      // Whichever of the two questions it asks, the last button signs out.
      await page.getByRole('dialog').getByRole('button', { name: /sign out/i }).last().click()
      log('with a connection, signing out reaches the database',
        await until(async () => (await page.getByRole('heading', { name: /sign in/i }).count()) === 1) && logouts.length === 1,
        `${logouts.length}`)
      log('and ends this device\'s login, not every device\'s', logouts.join() === 'local', logouts.join())
      await ctx.close()
    }
  }

  // ── Never loaded here ─────────────────────────────────────────────────────
  {
    const { ctx, page } = await newDevice()
    await hasBeenHere(page, { copy: false })
    await ctx.setOffline(true)
    await page.reload({ waitUntil: 'load' })
    log('with a team but no data yet, it says what it needs',
      await until(async () => /doesn't have your team's data yet/.test(await page.textContent('body'))), (await page.textContent('body')).slice(0, 150))
    await ctx.close()
  }
  {
    const { ctx, page } = await newDevice()
    await hasBeenHere(page, { copy: false })
    await page.evaluate(() => localStorage.removeItem('fc.session.teams'))
    await ctx.setOffline(true)
    await page.reload({ waitUntil: 'load' })
    log('with no team known either, it says that',
      await until(async () => /doesn't have your team yet/.test(await page.textContent('body'))), (await page.textContent('body')).slice(0, 150))
    await ctx.close()
  }

  // ── A deploy still gets through ───────────────────────────────────────────
  {
    const { ctx, page } = await newDevice()
    const original = readFileSync(join(OUT, 'index.html'), 'utf8')
    writeFileSync(join(OUT, 'index.html'), original.replace('</head>', '<meta name="pemcora-test" content="newer"></head>'))
    await page.reload({ waitUntil: 'load' })
    log('with a connection the main page comes from the network',
      (await page.locator('meta[name="pemcora-test"]').count()) === 1)
    await ctx.setOffline(true)
    await page.reload({ waitUntil: 'load' })
    log('with none it comes from the build it was kept with',
      (await page.locator('meta[name="pemcora-test"]').count()) === 0 && (await page.getByRole('heading', { name: /sign in/i }).count()) >= 0)
    writeFileSync(join(OUT, 'index.html'), original)
    await ctx.close()
  }

  // ── A new build takes over ────────────────────────────────────────────────
  {
    const { ctx, page } = await newDevice()
    const firstKeys = await page.evaluate(() => caches.keys())
    const next = sw.replace(/const BUILD = '[^']*'/, `const BUILD = '${Date.now() + 1000}-next'`)
    writeFileSync(join(OUT, 'sw.js'), next)
    await page.reload({ waitUntil: 'load' })
    const taken = await until(async () =>
      (await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration()
        await registration.update().catch(() => {})
        return (await caches.keys()).length
      })) === firstKeys.length + 1)
    log('a new build\'s worker installs beside the old one', taken)
    const after = await page.evaluate(() => caches.keys())
    log('keeping the last build, for a tab still open on it', firstKeys.every(k => after.includes(k)), after.join())
    writeFileSync(join(OUT, 'sw.js'), sw)
    await ctx.close()
  }

  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} catch (e) {
  console.log('FAIL  suite threw before finishing — ' + e.message)
} finally {
  await browser.close()
  server.kill()
  process.exit(0)
}
