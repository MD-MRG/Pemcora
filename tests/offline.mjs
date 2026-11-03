/**
 * Offline and multiple devices, through the real screens (build plan B3).
 *
 * The app runs in a real browser with real device storage, and real browser
 * contexts play the devices, sharing one stand-in database (fake-server.mjs) that
 * lives here in the test. `context.setOffline()` takes a device off the network,
 * and the page itself finds out as it would in the field.
 *
 * The five cases the plan asks for:
 *   a reload with unsaved changes · a dropped connection mid-visit · a visit
 *   continued the next day · two devices on the same visit · a refused offline start
 *
 * tests/save-queue.mjs covers the rules in more depth, without a browser. Nothing
 * here can reach the live project: every request off this machine is refused.
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'
import { FakeServer } from './fake-server.mjs'

const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') =>
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const browser = await launch()
const pageErrors = []
// What the app logs as an error. Requests this suite refuses on purpose log one too,
// as does a save tried with the connection off, so those are left out.
const consoleErrors = []
const expected = /^Failed to load resource|^\[cache\] save failed .*Failed to fetch/
const watchConsole = page =>
  page.on('console', m => {
    if (m.type() === 'error' && !expected.test(m.text())) consoleErrors.push(m.text())
  })
const localhost = new URL(BASE).hostname

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function until(check, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

// A device: its own browser storage, talking to the shared database.
async function newDevice(server) {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  await ctx.exposeFunction('__fake', (name, args) => server.call(name, args))
  await ctx.route('**/*', route => {
    const host = new URL(route.request().url()).hostname
    return host === localhost ? route.continue() : route.abort()
  })
  return ctx
}

// What DataBoot does, with the database swapped for the shared stand-in.
async function connect(page) {
  await page.evaluate(async () => {
    // The very modules the app loaded. After an edit, the dev server serves them
    // with a ?t= stamp, and importing the plain path would get a second copy.
    const loaded = path =>
      performance
        .getEntriesByType('resource')
        .map(e => e.name)
        .filter(url => url.includes(path))
        .pop() ?? path
    const cache = await import(loaded('/src/lib/cache.js'))
    const { supabaseAdapter } = await import(loaded('/src/lib/adapters/supabase.js'))
    const { deviceCopies } = await import(loaded('/src/lib/offlineStore.js'))
    const source = new Proxy(
      {},
      {
        get: (_, name) => async (...args) => {
          if (!navigator.onLine) throw { code: '', message: 'TypeError: Failed to fetch' }
          const { data, error } = await window.__fake(name, args)
          if (error) throw error.thrown ? Object.assign(new Error(error.message), error) : error
          return data
        },
      },
    )
    cache.resetCache()
    await cache.hydrate(supabaseAdapter('team', 'user', source), {
      device: deviceCopies('user', 'team'),
    })
  })
}

async function open(ctx) {
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  watchConsole(page)
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await connect(page)
  return page
}

async function goToSite(page) {
  await page.locator('nav a').filter({ hasText: 'Settings' }).click()
  await page.locator('nav a').filter({ hasText: 'Preventative Maintenance' }).click()
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
}

const startButton = page => page.getByRole('button', { name: /^(Start PM|Start new visit)$/ })
const openRoom = (page, name) => page.getByRole('button', { name: new RegExp(`^Room ${name}`) }).click()
const resultButton = (page, test, value) => page.getByRole('button', { name: `${test}: ${value}`, exact: true })
const answer = (page, test, value) => resultButton(page, test, value).click()
const isPressed = async (page, test, value) =>
  (await resultButton(page, test, value).getAttribute('aria-pressed')) === 'true'
const backToSite = page => page.getByRole('button', { name: /^Back|←/ }).first().click()

const status = async page => {
  const el = page.locator('div.text-right[role="status"]')
  return (await el.count()) ? (await el.textContent()).trim() : ''
}
const statusIs = (page, pattern) => until(async () => pattern.test(await status(page)))

// A test's answer on the database, by its label rather than its id.
const onServer = (server, visitId, room, testLabel) => {
  const row = server.visits.get(visitId)?.rooms[room]
  const test = row?.template?.tests?.find(t => t.label === testLabel)
  return test ? row.results?.main?.[test.id] : undefined
}

const FIRST = 'Correct Time and Date'
const SECOND = 'Room Wake On Touch'
const THIRD = 'Test call performed'
const FOURTH = 'Audio In room'

try {
  // ── Online ────────────────────────────────────────────────────────────────
  const server = new FakeServer()
  server.seedClient()
  const ctx = await newDevice(server)
  let page = await open(ctx)

  log('the header says where the work is', /Saved/.test(await status(page)), await status(page))

  await goToSite(page)
  await startButton(page).click()
  log('online, the visit is on the database as it opens',
    await until(async () => server.visits.size === 1 && (await page.getByRole('button', { name: /^Continue$/ }).count()) === 1))
  const visitId = [...server.visits.keys()][0]

  await openRoom(page, 'r1')
  await answer(page, FIRST, 'PASS')
  log('an answer reaches the database', await until(() => onServer(server, visitId, 'r1', FIRST) === 'PASS'))
  log('and the header says Saved', await statusIs(page, /^Saved$/), await status(page))

  // ── A dropped connection mid-visit ────────────────────────────────────────
  await ctx.setOffline(true)
  log('losing the connection shows at once',
    await statusIs(page, /^Offline: changes are kept on this device$/), await status(page))
  await answer(page, SECOND, 'FAIL')
  await page.getByPlaceholder('Describe the issue / action taken').fill('Panel rebooted')
  await page.locator('h1').click() // leaves the note field
  await sleep(800)
  log('the visit carries on with no connection', await isPressed(page, SECOND, 'FAIL'))
  log('nothing has reached the database', onServer(server, visitId, 'r1', SECOND) === undefined)
  const copy = await page.evaluate(async () => {
    const { unsavedCopies } = await import('/src/lib/offlineStore.js')
    const [first] = await unsavedCopies('user')
    return first ? { unsaved: first.unsaved, room: first.data.clients[0].locations[0].visits[0].rooms.r1 } : null
  })
  log('the answer and note are in the device\'s storage, marked unsent',
    copy?.unsaved === true && Object.values(copy.room.troubleshooting).includes('Panel rebooted'))

  await ctx.setOffline(false)
  log('when the connection returns they go by themselves',
    await until(() => onServer(server, visitId, 'r1', SECOND) === 'FAIL'))
  log('notes too', Object.values(server.visits.get(visitId).rooms.r1.troubleshooting).includes('Panel rebooted'))
  log('and the header says Saved', await statusIs(page, /^Saved$/), await status(page))

  // ── A reload with unsaved changes ─────────────────────────────────────────
  server.down = true
  await answer(page, THIRD, 'N/A')
  log('a save that can\'t get through says offline', await statusIs(page, /^Offline/), await status(page))

  await page.reload({ waitUntil: 'networkidle' })
  await connect(page)
  await goToSite(page)
  await openRoom(page, 'r1')
  log('after a reload the unsaved answer is back', await isPressed(page, THIRD, 'N/A'))
  log('with the saved ones', await isPressed(page, FIRST, 'PASS') && await isPressed(page, SECOND, 'FAIL'))
  log('still offline, and it says so', /^Offline/.test(await status(page)), await status(page))

  server.down = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  log('it goes when the connection returns', await until(() => onServer(server, visitId, 'r1', THIRD) === 'NA'))

  // Closing the tab straight after an edit, with no time for anything to finish.
  server.down = true
  await answer(page, FOURTH, 'PASS')
  await page.close()
  server.down = false
  page = await open(ctx)
  log('an edit followed at once by closing the tab still arrives',
    await until(() => onServer(server, visitId, 'r1', FOURTH) === 'PASS'))
  const copies = await page.evaluate(async () => {
    const db = await new Promise(resolve => {
      const r = indexedDB.open('pemcora-offline')
      r.onsuccess = () => resolve(r.result)
    })
    return new Promise(resolve => {
      const r = db.transaction('copies').objectStore('copies').getAll()
      r.onsuccess = () => resolve(r.result.length)
    })
  })
  log('and leaves one copy on the device, not two', copies === 1, `${copies}`)

  log('the visit was counted once through all of that', server.counted === 1, `${server.counted}`)
  await page.close()
  await ctx.close()

  // ── A visit continued the next day ────────────────────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    const ctx = await newDevice(server)
    let page = await open(ctx)
    await goToSite(page)
    await startButton(page).click()
    await until(() => server.visits.size === 1)
    const id = [...server.visits.keys()][0]
    await openRoom(page, 'r1')
    await answer(page, FIRST, 'PASS')
    await until(() => onServer(server, id, 'r1', FIRST) === 'PASS')
    await page.close()

    // The next day: the app opens fresh, and the visit is where it was left.
    server.visits.get(id).startedAt = new Date(Date.now() - 86400000).toISOString()
    page = await open(ctx)
    await goToSite(page)
    log('the next day the visit is still open',
      (await page.getByRole('button', { name: /^Continue$/ }).count()) === 1 && /in progress/.test(await page.textContent('main')))
    await openRoom(page, 'r1')
    log('with yesterday\'s answers', await isPressed(page, FIRST, 'PASS'))
    await answer(page, SECOND, 'PASS')
    log('today\'s join them', await until(() => onServer(server, id, 'r1', SECOND) === 'PASS'))
    log('and it is not counted again', server.counted === 1, `${server.counted}`)
    await page.close()
    await ctx.close()
  }

  // ── Two devices on the same visit ─────────────────────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    const [ctxA, ctxB] = [await newDevice(server), await newDevice(server)]
    const [a, b] = [await open(ctxA), await open(ctxB)]
    await goToSite(a)
    await goToSite(b)

    await startButton(a).click()
    await until(() => server.visits.size === 1)
    const id = [...server.visits.keys()][0]

    // B opened the page before A started, so it still offers to start.
    await startButton(b).click()
    log('the second device is told it has joined',
      await until(async () => /already started this visit/.test(await b.textContent('main'))))
    log('there is still one visit, counted once', server.visits.size === 1 && server.counted === 1)

    await openRoom(a, 'r1')
    await openRoom(b, 'r1')
    await answer(a, FIRST, 'PASS')
    await until(() => onServer(server, id, 'r1', FIRST) === 'PASS')
    await answer(b, SECOND, 'FAIL')
    log('each device\'s answers end up in the same room',
      await until(() => onServer(server, id, 'r1', FIRST) === 'PASS' && onServer(server, id, 'r1', SECOND) === 'FAIL'))
    log('the second device sees the first one\'s answer on screen', await until(() => isPressed(b, FIRST, 'PASS')))

    await answer(a, THIRD, 'PASS')
    log('the first device\'s next save keeps the second one\'s answer',
      await until(() => onServer(server, id, 'r1', THIRD) === 'PASS') && onServer(server, id, 'r1', SECOND) === 'FAIL')
    log('and shows it on screen', await until(() => isPressed(a, SECOND, 'FAIL')))

    await answer(a, FOURTH, 'PASS')
    await sleep(900)
    log('a later save doesn\'t undo the merge',
      onServer(server, id, 'r1', SECOND) === 'FAIL' && onServer(server, id, 'r1', FIRST) === 'PASS' && onServer(server, id, 'r1', FOURTH) === 'PASS')

    await a.close()
    await b.close()
    await ctxA.close()
    await ctxB.close()
  }
  {
    // The same visit started on both, with one of them offline.
    const server = new FakeServer()
    server.seedClient()
    const [ctxA, ctxB] = [await newDevice(server), await newDevice(server)]
    const [a, b] = [await open(ctxA), await open(ctxB)]
    await goToSite(a)
    await goToSite(b)

    await ctxA.setOffline(true)
    await startButton(a).click()
    log('offline, the visit opens on this device', await until(async () => /Started on this device/.test(await a.textContent('main'))))
    await openRoom(a, 'r1')
    await answer(a, FIRST, 'FAIL')
    await sleep(300)

    await startButton(b).click()
    await until(() => server.visits.size === 1)
    const id = [...server.visits.keys()][0]
    await openRoom(b, 'r1')
    await answer(b, SECOND, 'PASS')
    await until(() => onServer(server, id, 'r1', SECOND) === 'PASS')
    server.visitLimit = 1 // the allowance is used up, which doesn't stop a join

    await ctxA.setOffline(false)
    log('coming back online joins the open visit',
      await until(() => onServer(server, id, 'r1', FIRST) === 'FAIL'))
    log('with both devices\' answers, in one visit counted once',
      server.visits.size === 1 && onServer(server, id, 'r1', SECOND) === 'PASS' && server.counted === 1,
      `visits=${server.visits.size} counted=${server.counted}`)
    log('the open room catches up on screen', await until(() => isPressed(a, SECOND, 'PASS')))
    await answer(a, THIRD, 'PASS')
    log('and carries on saving, into the visit it joined',
      await until(() => onServer(server, id, 'r1', THIRD) === 'PASS') && onServer(server, id, 'r1', SECOND) === 'PASS')
    log('no refusal anywhere', !/not saved/i.test(await status(a)) && /^Saved$/.test(await status(a)), await status(a))

    await a.close()
    await b.close()
    await ctxA.close()
    await ctxB.close()
  }

  // ── A refused offline start ───────────────────────────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    server.seedClient({ id: 'c2', name: 'Other Co', locationId: 'l2', rooms: ['r9'] })
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await goToSite(page)

    await ctx.setOffline(true)
    await startButton(page).click()
    await until(async () => /Started on this device/.test(await page.textContent('main')))
    await openRoom(page, 'r1')
    await answer(page, FIRST, 'PASS')
    await sleep(300)

    server.visitLimit = 0
    await ctx.setOffline(false)
    log('the header counts it as not saved',
      await statusIs(page, /1 visit not saved/), await status(page))
    log('and everything else is saved', /^Saved/.test(await status(page)), await status(page))
    log('it isn\'t on the database', server.visits.size === 0)
    log('the answer is still there', await isPressed(page, FIRST, 'PASS'))
    await answer(page, SECOND, 'PASS')
    await sleep(800)
    log('more can be entered into it', await isPressed(page, SECOND, 'PASS'))

    await backToSite(page)
    log('the visit shows why it isn\'t saved',
      await until(async () => /Not saved:/.test(await page.textContent('main')) && /inspection/.test(await page.textContent('main'))))

    await page.locator('nav a').filter({ hasText: 'Home' }).click()
    log('Home lists it under Needs attention',
      await until(async () => /Not saved/.test(await page.textContent('main')) && /only on this device/.test(await page.textContent('main'))),
      (await page.textContent('main')).slice(0, 200))
    await page.getByRole('button', { name: 'Open visit' }).click()
    log('and goes straight to it', await until(async () => /Not saved:/.test(await page.textContent('main'))))

    await page.getByRole('button', { name: 'Try again' }).click()
    await sleep(400)
    log('trying again while still refused changes nothing',
      /Not saved:/.test(await page.textContent('main')) && server.visits.size === 0)

    server.visitLimit = null
    await page.getByRole('button', { name: 'Try again' }).click()
    log('after an upgrade it saves', await until(() => server.visits.size === 1))
    const id = [...server.visits.keys()][0]
    log('with everything entered', onServer(server, id, 'r1', FIRST) === 'PASS' && onServer(server, id, 'r1', SECOND) === 'PASS')
    log('and the notice goes', await until(async () => !/Not saved:/.test(await page.textContent('main'))))
    log('so does the count in the header', await statusIs(page, /^Saved$/), await status(page))
    await page.close()
    await ctx.close()
  }
  {
    // A refused visit can still be reported on, survives a reload, and can be dropped.
    const server = new FakeServer()
    server.seedClient()
    const ctx = await newDevice(server)
    let page = await open(ctx)
    await goToSite(page)
    await ctx.setOffline(true)
    await startButton(page).click()
    await until(async () => /Started on this device/.test(await page.textContent('main')))
    server.visitLimit = 0
    await ctx.setOffline(false)
    log('a refusal shows on the visit page as it happens, with nothing touched',
      await until(async () => /Not saved:/.test(await page.textContent('main'))))
    log('and the note about being offline goes', !/Started on this device/.test(await page.textContent('main')))

    await page.reload({ waitUntil: 'networkidle' })
    await connect(page)
    await goToSite(page)
    log('a refused visit survives a reload, still marked',
      await until(async () => /Not saved:/.test(await page.textContent('main'))))

    const download = page.waitForEvent('download', { timeout: 15000 })
    await page.getByRole('button', { name: 'Export report' }).click()
    log('and can still be exported to Excel', /\.xlsx$/.test((await download).suggestedFilename()))
    await sleep(300)

    await page.getByRole('button', { name: 'Discard' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
    log('or discarded', await until(async () => !/Not saved:/.test(await page.textContent('main'))))
    log('leaving no visit behind', await statusIs(page, /^Saved$/) && server.visits.size === 0, await status(page))
    await page.close()
    await ctx.close()
  }

  // ── Deleting a report record ──────────────────────────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await goToSite(page)
    await startButton(page).click()
    await until(() => server.visits.size === 1)
    const id = [...server.visits.keys()][0]

    let download = page.waitForEvent('download', { timeout: 15000 })
    await page.getByRole('button', { name: 'Export report' }).click()
    await download
    log('an exported report is recorded on the database', await until(() => server.visits.get(id).exports.length === 1))

    await page.getByRole('button', { name: 'Delete revision 1' }).click()
    await page.getByRole('button', { name: 'Delete record' }).click()
    log('deleting the record deletes it on the database', await until(() => server.visits.get(id).exports.length === 0))

    await page.reload({ waitUntil: 'networkidle' })
    await connect(page)
    await goToSite(page)
    log('and it doesn\'t come back on the next load', (await page.getByRole('button', { name: 'Delete revision 1' }).count()) === 0)
    await page.close()
    await ctx.close()
  }

  // ── Signing out ───────────────────────────────────────────────────────────
  {
    const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
    const page = await ctx.newPage()
    page.on('pageerror', e => pageErrors.push(e.message))
    watchConsole(page)
    await page.goto(BASE + '#/', { waitUntil: 'networkidle' })

    const mount = unsaved =>
      page.evaluate(async unsaved => {
        const { mountAccountCard } = await import('/tests/fixtures/mount-account-card.jsx')
        mountAccountCard({ unsaved })
      }, unsaved)
    const choices = () => page.evaluate(() => window.__signOuts)

    await mount(false)
    await page.getByRole('button', { name: 'Sign out' }).click()
    log('with nothing unsaved, signing out says the device copy is wiped',
      /wiped/.test(await page.getByRole('dialog').textContent()))
    await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click()
    log('and keeps nothing', (await choices())[0]?.keep === false)

    await mount(true)
    await page.getByRole('button', { name: 'Sign out' }).click()
    const dialog = await page.getByRole('dialog').textContent()
    log('with unsaved work it asks, and says who could read it',
      /isn't saved yet/.test(dialog) && /anyone using this browser/.test(dialog), dialog)
    await page.getByRole('button', { name: 'Stay signed in' }).click()
    log('staying signed in is a way out', (await page.getByRole('dialog').count()) === 0 && (await choices()).length === 0)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('button', { name: 'Keep it and sign out' }).click()
    log('it can be kept', (await choices())[0]?.keep === true)

    await mount(true)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await page.getByRole('button', { name: 'Discard it and sign out' }).click()
    log('or discarded', (await choices())[0]?.keep === false)

    // What those choices do to the device's storage.
    const remaining = await page.evaluate(async () => {
      const store = await import('/src/lib/offlineStore.js')
      const save = async (user, team, tab, unsaved) => {
        sessionStorage.setItem('fc.tab', tab)
        const device = store.deviceCopies(user, team)
        await device.load()
        device.save({ data: { clients: [] }, snapshot: { clients: [] }, held: {}, unsaved })
      }
      await save('sam', 'team-1', 'a', true)
      await save('sam', 'team-2', 'b', false)
      await save('pat', 'team-1', 'c', false)
      await new Promise(r => setTimeout(r, 100))
      const unsaved = (await store.unsavedCopies('sam')).map(c => c.teamId)
      await store.clearCopies('sam', { keepUnsaved: true })
      const afterKeep = (await store.unsavedCopies('sam')).map(c => c.teamId)
      await store.clearCopies('sam')
      const afterWipe = (await store.unsavedCopies('sam')).length
      const pat = (await store.deviceCopies('pat', 'team-1').load()).own?.userId
      return { unsaved, afterKeep, afterWipe, pat }
    })
    log('the device knows which copies hold unsaved work', remaining.unsaved.join() === 'team-1', remaining.unsaved.join())
    log('keeping leaves only those', remaining.afterKeep.join() === 'team-1')
    log('discarding wipes them', remaining.afterWipe === 0)
    log('and never touches another person\'s', remaining.pat === 'pat')
    await ctx.close()
  }

  // ── The real database layer, against real answers ─────────────────────────
  // The stand-in answers in the shape of api.js, so this checks api.js itself: the
  // real Supabase client, with the answers PostgREST gives. Nothing leaves this
  // machine: every request off it is answered here.
  {
    const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
    const page = await ctx.newPage()
    const requests = []
    const sent = [] // what went with each request: its query and its body
    let script = []
    await ctx.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.hostname === localhost) return route.continue()
      sent.push({ search: decodeURIComponent(url.search), body: request.postData() ? JSON.parse(request.postData()) : null })
      requests.push(`${request.method()} ${url.pathname.replace('/rest/v1', '')}${request.method() === 'DELETE' ? url.search : ''}`)
      const next = script.shift()
      if (!next) return route.abort()
      return route.fulfill({
        status: next.status,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' },
        body: JSON.stringify(next.body),
      })
    })
    await page.goto(BASE + '#/', { waitUntil: 'networkidle' })

    const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
    if (!configured) {
      console.log('(the database layer checks need VITE_SUPABASE_URL in .env, and were skipped)')
    } else {
      const call = (method, args) =>
        page.evaluate(
          async ({ method, args }) => {
            const api = await import('/src/lib/api.js')
            try {
              return { data: await api[method](...args) }
            } catch (e) {
              return { error: { message: e.message, code: e.code, hint: e.hint } }
            }
          },
          { method, args },
        )
      const row = (id, extra = {}) => ({
        id, location_id: 'l1', kind: 'maintenance', technician: 'Pat', started_at: '2026-10-01T00:00:00+00:00',
        completed_at: null, first_completed_at: null, visit_rooms: [], visit_exports: [], ...extra,
      })
      const duplicate = { status: 409, body: { code: '23505', message: 'duplicate key', details: null, hint: null } }
      const startArgs = ['t', 'l1', 'maintenance', 'Sam', 'u', 'mine', '2026-10-01T00:00:00Z']

      script = [{ status: 201, body: row('mine') }]
      let out = await call('startVisit', startArgs)
      log('a visit goes in with its own id', out.data?.id === 'mine', JSON.stringify(out.error))

      script = [duplicate, { status: 200, body: [row('mine')] }]
      out = await call('startVisit', startArgs)
      log('sent again after its answer was lost, it finds itself', out.data?.id === 'mine', JSON.stringify(out))

      script = [duplicate, { status: 200, body: [] }, { status: 200, body: [row('theirs')] }]
      out = await call('startVisit', startArgs)
      log('another device\'s open visit is handed back', out.data?.id === 'theirs', JSON.stringify(out.error))

      script = [duplicate, { status: 200, body: [] }, { status: 200, body: [row('old', { first_completed_at: '2025-01-01T00:00:00+00:00' })] }]
      out = await call('startVisit', startArgs)
      log('with its first completion date, which is what marks a correction', !!out.data?.firstCompletedAt, JSON.stringify(out.error))

      script = [duplicate, { status: 200, body: [] }, { status: 200, body: [] }, { status: 201, body: row('mine') }]
      out = await call('startVisit', startArgs)
      log('finished in the moment between, it just tries again', out.data?.id === 'mine', JSON.stringify(out.error))

      script = [{ status: 402, body: { code: 'PT402', message: 'Used up', details: null, hint: 'upgrade' } }]
      out = await call('startVisit', startArgs)
      log('a refusal comes through with its code and hint', out.error?.code === 'PT402' && out.error?.hint === 'upgrade', JSON.stringify(out.error))

      script = [{ status: 200, body: [] }]
      out = await call('updateVisit', ['gone', { technician: 'Sam' }])
      log('updating a visit that is no longer there says so', out.error?.code === 'VISIT_GONE', JSON.stringify(out.error))

      script = [{ status: 200, body: [{ id: 'v1' }] }]
      out = await call('updateVisit', ['v1', { technician: 'Sam' }])
      log('updating one that is there is fine', !out.error, JSON.stringify(out.error))

      // Something deleted on another device. The real database's security rules
      // answer "not allowed" before its foreign key can answer "missing", so api.js
      // looks for the parent. tests/offline-e2e.mjs found this against the real one.
      const notAllowed = table => ({
        status: 403,
        body: { code: '42501', message: `new row violates row-level security policy for table "${table}"`, details: null, hint: null },
      })
      const found = { status: 200, body: [{ id: 'x' }] }
      const missing = { status: 200, body: [] }
      const entry = { roomName: 'Room r1', results: { main: {} } }

      script = [notAllowed('visit_rooms'), found, missing]
      out = await call('saveVisitRoom', ['t', 'v1', 'r1', entry])
      log('a room deleted on another device is reported as gone, not refused', out.error?.code === '23503', JSON.stringify(out.error))
      log('having looked for the visit, then the room', requests.slice(-2).join() === 'GET /visits,GET /rooms', requests.slice(-3).join(' | '))

      script = [notAllowed('visit_rooms'), missing]
      out = await call('saveVisitRoom', ['t', 'v1', 'r1', entry])
      log('so is a visit deleted on another device, without looking further',
        out.error?.code === '23503' && requests.at(-1) === 'GET /visits', requests.slice(-2).join(' | '))

      script = [notAllowed('visit_rooms'), found, found]
      out = await call('saveVisitRoom', ['t', 'v1', 'r1', entry])
      log('with both still there, a refusal stays a refusal', out.error?.code === '42501', JSON.stringify(out.error))

      script = [notAllowed('visit_rooms')] // and looking gets no answer at all
      out = await call('saveVisitRoom', ['t', 'v1', 'r1', entry])
      log('with no way to look, it stays a refusal too', out.error?.code === '42501', JSON.stringify(out.error))

      script = [{ status: 409, body: { code: '23514', message: 'The date', details: null, hint: 'visit_date' } }]
      out = await call('saveVisitRoom', ['t', 'v1', 'r1', entry])
      log('and nothing else sends it looking', out.error?.code === '23514' && requests.at(-1) === 'POST /visit_rooms', requests.at(-1))

      for (const [method, args, table, parent] of [
        ['saveRoomlessVisitRoom', ['t', 'v1', entry], 'visit_rooms', 'visit'],
        ['recordExport', ['t', 'v1', 1, 'report.xlsx', 'u'], 'visit_exports', 'visit'],
        ['startVisit', startArgs, 'visits', 'location'],
        ['addLocation', ['t', 'c1', { address: '1 High St' }, 'l1'], 'locations', 'client'],
        ['addFloor', ['t', 'l1', { id: 'f1', label: 'Ground' }, 0], 'floors', 'location'],
        ['addRoom', ['t', 'f1', { id: 'r1', name: 'Room' }, 0], 'rooms', 'floor'],
      ]) {
        script = [notAllowed(table), missing]
        out = await call(method, args)
        log(`${method}: under a ${parent} deleted on another device, it's gone`,
          out.error?.code === '23503' && requests.at(-1) === `GET /${parent}s`, `${JSON.stringify(out.error)} ${requests.at(-1)}`)
      }

      const client = { id: 'c1', name: 'Equinix', locations: [] }
      script = [duplicate, { status: 200, body: [client] }]
      out = await call('createClient', ['t', 'Equinix', 'c1'])
      log('a client sent again finds itself', out.data?.id === 'c1', JSON.stringify(out.error))

      script = [duplicate, { status: 200, body: [] }]
      out = await call('createClient', ['t', 'Equinix', 'c1'])
      log('another client with that name is a conflict, with a useful message',
        out.error?.code === '23505' && /already exists/.test(out.error.message), JSON.stringify(out.error))

      script = [duplicate, { status: 200, body: [{ id: 'l1', floors: [] }] }]
      out = await call('addLocation', ['t', 'c1', { address: '8 Grand Avenue' }, 'l1'])
      log('a site sent again finds itself', out.data?.id === 'l1', JSON.stringify(out.error))

      script = [duplicate, { status: 200, body: [] }]
      out = await call('addLocation', ['t', 'c1', { address: '8 Grand Avenue' }, 'l1'])
      log('another site at that address is a conflict', out.error?.code === '23505', JSON.stringify(out.error))

      script = [duplicate]
      out = await call('addFloor', ['t', 'l1', { id: 'f1', label: 'Ground' }, 0])
      log('a floor sent again is fine', out.data?.id === 'f1', JSON.stringify(out.error))
      script = [duplicate]
      out = await call('addRoom', ['t', 'f1', { id: 'r1', name: 'Lobby' }, 0])
      log('so is a room', out.data?.id === 'r1', JSON.stringify(out.error))

      requests.length = 0
      script = [{ status: 204, body: null }]
      out = await call('deleteExport', ['v1', 2])
      log('deleting a report record asks for just that one',
        !out.error && requests.join() === 'DELETE /visit_exports?visit_id=eq.v1&revision=eq.2', requests.join() + JSON.stringify(out.error))

      script = [{ status: 200, body: [] }]
      out = await call('saveTemplate', ['t', 'maintenance', {}])
      log('a list a member may not change is a coded refusal', out.error?.code === '42501', JSON.stringify(out.error))
      script = [{ status: 200, body: [] }]
      out = await call('updateTeamSettings', ['t', { plate: 'brass' }])
      log('so is the company branding', out.error?.code === '42501', JSON.stringify(out.error))

      script = [{ status: 200, body: [] }]
      out = await call('getVisitRoom', ['v1', 'r1'])
      log('a room the database doesn\'t have reads as nothing', out.data === null, JSON.stringify(out))
      requests.length = 0
      script = [{
        status: 200,
        body: [{ results: { main: { t1: 'PASS' } }, troubleshooting: {}, sections_enabled: {}, comments: 'Hi', status: 'in_progress', fails: 0, updated_at: '2026-10-01T00:00:00+00:00' }],
      }]
      out = await call('getVisitRoom', ['v1', 'r1'])
      log('a room comes back in the app\'s shape',
        out.data?.results?.main?.t1 === 'PASS' && out.data.status === 'in-progress' && out.data.updatedAt && out.data.comments === 'Hi', JSON.stringify(out.error))
      log('every request stayed on this machine', requests.every(r => r.startsWith('GET /visit_rooms')), requests.join(' | '))

      // Readings, the whole-site step and room types (C1).
      script = [{
        status: 200,
        body: [{ results: {}, readings: { main: { t1: { value: '0.4', unit: 'Ω' } } }, troubleshooting: {}, sections_enabled: {}, comments: '', status: 'in_progress', fails: 0, updated_at: '2026-10-01T00:00:00+00:00' }],
      }]
      out = await call('getVisitRoom', ['v1', 'r1'])
      log('a room\'s readings are asked for, and come back with it',
        out.data?.readings?.main?.t1?.value === '0.4' && /readings/.test(sent.at(-1).search), sent.at(-1).search)

      script = [{ status: 201, body: { id: 'x', visit_id: 'v1', room_id: 'r1', results: {}, readings: { main: { t1: { value: '1', unit: 'ms' } } } } }]
      out = await call('saveVisitRoom', ['t', 'v1', 'r1', { ...entry, readings: { main: { t1: { value: '1', unit: 'ms' } } } }])
      log('and are saved with it', sent.at(-1).body?.readings?.main?.t1?.unit === 'ms' && out.data?.readings?.main?.t1?.value === '1', JSON.stringify(sent.at(-1).body))

      script = [{ status: 200, body: [{ id: 'v1', completed_at: '2025-01-01T00:00:00+00:00' }] }]
      out = await call('updateVisit', ['v1', { siteResults: { results: { ss: { w1: 'PASS' } } }, completedAt: '2026-10-01T00:00:00Z' }])
      log('the whole-site step is saved on the visit', sent.at(-1).body?.site_results?.results?.ss?.w1 === 'PASS', JSON.stringify(sent.at(-1).body))
      log('and the completion date the database kept comes back',
        out.data?.completedAt === '2025-01-01T00:00:00+00:00' && /completed_at/.test(sent.at(-1).search), JSON.stringify(out))
      script = [{ status: 200, body: [{ id: 'v1', completed_at: null }] }]
      out = await call('updateVisit', ['v1', { technician: 'Sam' }])
      log('a visit saved without one sends no whole-site step', !('site_results' in (sent.at(-1).body ?? {})), JSON.stringify(sent.at(-1).body))

      script = [{ status: 200, body: [{ site_results: { results: { ss: { w1: 'NA' } } } }] }]
      out = await call('getVisitSite', ['v1'])
      log('the whole-site step reads back on its own', out.data?.results?.ss?.w1 === 'NA' && /site_results/.test(sent.at(-1).search), JSON.stringify(out))
      script = [{ status: 200, body: [] }]
      out = await call('getVisitSite', ['gone'])
      log('from a visit that has gone, as nothing', out.data === null, JSON.stringify(out))

      script = [{ status: 201, body: row('mine', { site_results: { results: { ss: { w1: 'PASS' } } } }) }]
      out = await call('startVisit', startArgs)
      log('a visit comes back with its whole-site step', out.data?.siteResults?.results?.ss?.w1 === 'PASS', JSON.stringify(out.error))

      script = [{ status: 201, body: { id: 'r1', name: 'Bedroom 1', plan_number: '', room_type: 'bedroom', position: 0 } }]
      out = await call('addRoom', ['t', 'f1', { id: 'r1', name: 'Bedroom 1', roomType: 'bedroom' }, 0])
      log('a room goes in with its type, and comes back with it',
        sent.at(-1).body?.room_type === 'bedroom' && out.data?.roomType === 'bedroom', JSON.stringify(sent.at(-1).body))
      script = [{ status: 204, body: null }]
      out = await call('updateRoom', ['r1', { roomType: 'hallway' }])
      log('a changed type is sent', sent.at(-1).body?.room_type === 'hallway', JSON.stringify(sent.at(-1).body))
      script = [{ status: 204, body: null }]
      out = await call('updateRoom', ['r1', { name: 'Bedroom 2' }])
      log('and only when it changed', !('room_type' in (sent.at(-1).body ?? {})), JSON.stringify(sent.at(-1).body))

      // Equipment (C1b).
      const alarm = { id: 'a1', assetType: 'smoke_alarm', roomId: 'r1', label: 'Hall', attributes: { power: 'hardwired' }, createdAt: '2026-10-01T00:00:00Z' }
      script = [{ status: 201, body: { id: 'a1', location_id: 'l1', room_id: 'r1', asset_type: 'smoke_alarm', label: 'Hall', attributes: { power: 'hardwired' }, created_at: '2026-10-01T00:00:00+00:00' } }]
      out = await call('addAsset', ['t', 'l1', alarm])
      const added = sent.at(-1).body
      log('an item goes in under its own id, site, room and type',
        added?.id === 'a1' && added.location_id === 'l1' && added.room_id === 'r1' && added.asset_type === 'smoke_alarm' && added.team_id === 't', JSON.stringify(added))
      log('with the date it was added on the device, and its pack fields',
        added?.created_at === '2026-10-01T00:00:00Z' && added.attributes?.power === 'hardwired')
      log('and comes back in the app\'s shape', out.data?.assetType === 'smoke_alarm' && out.data.roomId === 'r1' && out.data.removedAt === null, JSON.stringify(out))
      script = [duplicate]
      out = await call('addAsset', ['t', 'l1', alarm])
      log('an item sent again is fine', out.data?.id === 'a1', JSON.stringify(out.error))
      script = [notAllowed('assets'), found, missing]
      out = await call('addAsset', ['t', 'l1', alarm])
      log('an item under a room deleted elsewhere is reported as gone',
        out.error?.code === '23503' && requests.at(-1) === 'GET /rooms', JSON.stringify(out.error) + ' ' + requests.at(-1))

      script = [{ status: 200, body: [{ id: 'a1' }] }]
      out = await call('updateAsset', ['a1', { label: 'Landing', removedAt: '2026-10-02T00:00:00Z' }])
      log('an edit sends only what changed',
        !out.error && JSON.stringify(Object.keys(sent.at(-1).body).sort()) === '["label","removed_at"]', JSON.stringify(sent.at(-1).body))
      script = [{ status: 200, body: [] }]
      out = await call('updateAsset', ['a1', { label: 'Landing' }])
      log('an edit to an item that has gone says so', out.error?.code === '23503', JSON.stringify(out.error))

      script = [{ status: 200, body: [{ id: 'a1', location_id: 'l1', room_id: null, asset_type: 'rcd', label: '', make: '', model: '', serial: '', attributes: {}, installed_on: null, expires_on: '2036-01-01', removed_at: null, created_at: '2026-10-01T00:00:00+00:00' }] }]
      out = await call('listAssets', ['t'])
      log('the team\'s items are read in one go', out.data?.[0]?.locationId === 'l1' && out.data[0].expiresOn === '2036-01-01' && out.data[0].roomId === null, JSON.stringify(out))

      // Signing off (C1f).
      const signoff = { technician: 'Sam', licence_number: 'A1', signed_at: '2026-10-01T00:00:00Z', signature: 'M1 1L2 2' }
      script = [{ status: 200, body: [{ id: 'v1', completed_at: '2026-10-01T01:00:00+00:00' }] }]
      out = await call('updateVisit', ['v1', { outcome: 'compliant', signoff, completedAt: '2026-10-01T01:00:00Z' }])
      log('the outcome and sign-off are saved on the visit',
        sent.at(-1).body?.outcome === 'compliant' && sent.at(-1).body?.signoff?.signature === 'M1 1L2 2', JSON.stringify(sent.at(-1).body))
      script = [{ status: 201, body: row('mine', { outcome: 'non_compliant', signoff: { ...signoff, signed_by: 'u' } }) }]
      out = await call('startVisit', startArgs)
      log('and read back with it', out.data?.outcome === 'non_compliant' && out.data?.signoff?.signed_by === 'u', JSON.stringify(out.error))
      script = [{ status: 200, body: [{ default_technician: 'Sam', licence_number: 'A1' }] }]
      out = await call('getMemberPrefs', ['t', 'u'])
      log('the technician\'s own licence number is read', out.data?.licenceNumber === 'A1' && out.data.defaultTechnician === 'Sam', JSON.stringify(out))

      // Licence numbers and the reminders switch (C3).
      script = [{ status: 201, body: null }]
      out = await call('saveMemberPrefs', ['t', 'u', { licenceNumber: 'A2' }])
      log('saving the licence number sends only it, so the technician\'s name is kept',
        !out.error && sent.at(-1).body?.licence_number === 'A2' && !('default_technician' in (sent.at(-1).body ?? {})), JSON.stringify(sent.at(-1).body))
      script = [{ status: 201, body: null }]
      out = await call('saveMemberPrefs', ['t', 'u', { defaultTechnician: 'Sam' }])
      log('and the other way round', sent.at(-1).body?.default_technician === 'Sam' && !('licence_number' in (sent.at(-1).body ?? {})), JSON.stringify(sent.at(-1).body))
      script = [{ status: 200, body: [{ team_id: 't', company: {}, reminders_enabled: false, plate: 'brass' }] }]
      out = await call('updateTeamSettings', ['t', { remindersEnabled: false }])
      log('the team\'s reminders switch is saved on its own',
        JSON.stringify(sent.at(-1).body) === '{"reminders_enabled":false}' && out.data?.remindersEnabled === false, JSON.stringify(sent.at(-1).body))
      script = [{ status: 200, body: { team_id: 't', company: { licence_number: 'L1', rec_number: 'R1' }, plate: 'brass' } }]
      out = await call('getTeamSettings', ['t'])
      log('and read back, on unless the team switched it off, with the company\'s numbers',
        out.data?.remindersEnabled === true && out.data.company.rec_number === 'R1', JSON.stringify(out))
    }
    await ctx.close()
  }

  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  // A team's lists are blank until first read, and the read that fills them in comes
  // while a page is being drawn. Only React's own warning shows if that tells the
  // header too soon.
  log('and nothing logged as an error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (e) {
  console.log('FAIL  suite threw before finishing — ' + e.message)
} finally {
  await browser.close()
}
