/**
 * What a team has, and what happens when the plan says no (build plan B4, 2.11).
 *
 * The rules and the store run in Node first. Then the real screens run in a browser,
 * against the same stand-in database as tests/offline.mjs, because whether a team sees
 * a page or a refusal gets a sheet can only be told from what is on screen.
 *
 * What it holds the app to:
 *   - a team without a pack doesn't see its pages, but keeps what it did under it
 *   - a landlord or agency has its own pages, and an inspector's aren't among them
 *   - with the limits off, nothing tells anyone to upgrade
 *   - a refusal is told by its code: HTTP 402 and hint `upgrade` get the sheet,
 *     anything else "Save failed", whatever either message says
 *   - "Upgrade to start" still asks the database, so a second device can join
 *   - a refusal in the background never interrupts anyone with a sheet
 *   - not knowing what a team has hides nothing
 *
 * tests/offline-open.mjs checks how DataBoot reads them, in a production build.
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'
import { FakeServer, memoryDevice } from './fake-server.mjs'

const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') =>
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function until(check, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// In Node: the rules and the store
// ─────────────────────────────────────────────────────────────────────────────

// A device's storage, for what the store keeps between openings.
const stored = new Map()
globalThis.localStorage = {
  getItem: key => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key),
}

const ent = await import('../src/lib/entitlements.js')
const cache = await import('../src/lib/cache.js')
const clientStore = await import('../src/lib/clientStore.js')
const { supabaseAdapter } = await import('../src/lib/adapters/supabase.js')
const { prefs } = await import('../src/lib/prefs.js')

const plan = (over = {}) => ({
  enforced: true,
  accountType: 'provider',
  plan: 'free',
  isPro: false,
  visitLimit: 1,
  visitsUsed: 0,
  packs: ['core', 'av'],
  pastDueUntil: null,
  cancelAt: null,
  ...over,
})

// ── The allowance ───────────────────────────────────────────────────────────
{
  const on = new Date('2026-11-02T00:00:00Z')
  log('the line the plan asks for',
    ent.usageLine(plan({ visitsUsed: 1 }), on) === '1 of 1 free inspection used this month · resets 1 Dec',
    ent.usageLine(plan({ visitsUsed: 1 }), on))
  log('more than one is plural',
    ent.usageLine(plan({ visitLimit: 5, visitsUsed: 2 }), on) === '2 of 5 free inspections used this month · resets 1 Dec',
    ent.usageLine(plan({ visitLimit: 5, visitsUsed: 2 }), on))
  log('visits counted while the limits were off don\'t read as 7 of 1',
    /^1 of 1 /.test(ent.usageLine(plan({ visitsUsed: 7 }), on)), ent.usageLine(plan({ visitsUsed: 7 }), on))
  log('no line with the limits off', ent.usageLine(plan({ enforced: false }), on) === null)
  log('no line with no limit, which is Pro or a promo', ent.usageLine(plan({ visitLimit: null }), on) === null)
  log('no line when nothing is known', ent.usageLine(null, on) === null)

  // Sydney is 11 hours ahead of UTC in November.
  log('still November in Sydney: resets 1 Dec',
    /resets 1 Dec$/.test(ent.usageLine(plan(), new Date('2026-11-30T12:30:00Z'))))
  log('half an hour later it is December in Sydney: resets 1 Jan',
    /resets 1 Jan$/.test(ent.usageLine(plan(), new Date('2026-11-30T13:30:00Z'))))
  log('December rolls over the year',
    ent.resetDay('long', new Date('2026-12-15T00:00:00Z')) === '1 January', ent.resetDay('long', new Date('2026-12-15T00:00:00Z')))

  log('used up, the Start button says so', ent.startNeedsUpgrade(plan({ visitsUsed: 1 }), 'maintenance'))
  log('with one left it doesn\'t', !ent.startNeedsUpgrade(plan(), 'maintenance'))
  log('nor with the limits off', !ent.startNeedsUpgrade(plan({ enforced: false, visitsUsed: 9 }), 'maintenance'))
  log('nor when nothing is known', !ent.startNeedsUpgrade(null, 'maintenance'))
  log('without the pack it does', ent.startNeedsUpgrade(plan({ packs: ['core'] }), 'maintenance'))
  log('but not with the limits off', !ent.startNeedsUpgrade(plan({ enforced: false, packs: ['core'] }), 'maintenance'))
  log('and never for a core workflow', !ent.startNeedsUpgrade(plan({ packs: ['core'] }), 'custom'))
}

// ── The banners ─────────────────────────────────────────────────────────────
{
  const now = new Date('2026-11-02T00:00:00Z')
  const day = 'T13:30:00Z' // already the next morning in Sydney
  const pastDue = ent.planBanners(plan({ pastDueUntil: `2026-11-08${day}` }), now)
  log('a declined card shows its deadline, by the date in Sydney',
    pastDue.length === 1 && /Update the card by 9 November/.test(pastDue[0].title), pastDue[0]?.title)
  const ending = ent.planBanners(plan({ cancelAt: `2026-11-14${day}` }), now)
  log('a plan that\'s ending shows when',
    ending.length === 1 && ending[0].title === 'Pro ends on 15 November.', ending[0]?.title)
  log('neither once the date has passed',
    ent.planBanners(plan({ pastDueUntil: '2026-11-01T00:00:00Z', cancelAt: '2026-11-01T00:00:00Z' }), now).length === 0)
  log('both can be true at once',
    ent.planBanners(plan({ pastDueUntil: `2026-11-08${day}`, cancelAt: `2026-11-14${day}` }), now).length === 2)
  log('nothing when nothing is known', ent.planBanners(null, now).length === 0)
}

// ── The sheet's wording ─────────────────────────────────────────────────────
{
  const on = new Date('2026-11-02T00:00:00Z')
  const used = ent.visitSheet(plan({ visitsUsed: 1 }), 'maintenance', on)
  log('it says what happened', used.title === 'You\'ve used this month\'s free inspection', used.title)
  log('and when it comes back', used.lines.join(' ').includes('1 December'), used.lines.join(' '))
  log('what Pro adds',
    ['Unlimited inspections', 'Photos', 'Your logo on reports', 'Re-check reminders'].every(a => used.adds.includes(a)))
  log('and that nothing entered is lost', used.kept === 'Anything you\'ve entered is kept and saves once you upgrade.')
  log('a bigger allowance says how big',
    /5 free inspections/.test(ent.visitSheet(plan({ visitLimit: 5, visitsUsed: 5 }), 'maintenance', on).title))
  log('with nothing known it still makes sense',
    ent.visitSheet(null, 'maintenance', on).title === 'You\'ve used this month\'s free inspections', ent.visitSheet(null, 'maintenance', on).title)

  const pack = ent.visitSheet(plan({ packs: ['core'] }), 'maintenance', on)
  log('a missing pack is named', /AV/.test(pack.title), pack.title)
  log('and offered', /^Add AV/.test(pack.action), pack.action)
  log('saying past work stays', /stay/.test(pack.lines.join(' ')))
  log('not talking about inspections', pack.adds.length === 0 && !/inspection/i.test(`${pack.title} ${pack.lines}`))

  const full = ent.seatSheet('Northpoint', { isPro: false })
  log('a full team says which', full.title === 'Northpoint is full', full.title)
  log('on Free it offers Pro', full.action === 'Upgrade to Pro' && full.adds.length > 0)
  log('on Pro it offers seats', ent.seatSheet('Northpoint', { isPro: true }).action === 'Add seats')
  log('and doesn\'t promise anything entered is kept, as nothing was', !full.kept)
}

// ── The store ───────────────────────────────────────────────────────────────
{
  stored.clear()
  const server = new FakeServer()
  server.plan = { visitLimit: 3 }
  let heard = 0
  const stop = ent.subscribeEntitlements(() => (heard += 1))

  log('nothing is known to start with', ent.currentEntitlements() === null)
  await ent.openEntitlements('team-a', 'user', server.api)
  log('opening reads them', ent.currentEntitlements()?.visitLimit === 3)
  log('and tells the screens', heard > 0)

  // The next opening answers at once with what this device last knew.
  ent.closeEntitlements()
  log('closing forgets them', ent.currentEntitlements() === null)
  const release = server.hold('getEntitlements')
  server.plan = { visitLimit: 9 }
  const opening = ent.openEntitlements('team-a', 'user', server.api)
  log('reopened, the last answer shows straight away', ent.currentEntitlements()?.visitLimit === 3)
  release()
  await opening
  log('until the new one arrives', ent.currentEntitlements()?.visitLimit === 9)

  server.down = true
  await ent.refreshEntitlements()
  log('no connection keeps what is known', ent.currentEntitlements()?.visitLimit === 9)
  server.down = false

  const logged = console.error
  let complained = 0
  console.error = () => (complained += 1)
  server.failNext('getEntitlements', { code: 'PGRST202', message: 'Could not find the function' })
  await ent.refreshEntitlements()
  console.error = logged
  log('a function that isn\'t on the project breaks nothing',
    ent.currentEntitlements()?.visitLimit === 9 && complained === 1)

  ent.closeEntitlements()
  await ent.openEntitlements('team-b', 'user', new FakeServer().api)
  log('another team starts from its own answer', ent.currentEntitlements()?.visitLimit === null)

  ent.closeEntitlements()
  const slow = new FakeServer()
  slow.plan = { visitLimit: 77 }
  const lets = slow.hold('getEntitlements')
  const late = ent.openEntitlements('team-c', 'user', slow.api)
  await ent.openEntitlements('team-d', 'user', new FakeServer().api)
  lets()
  await late
  log('a late answer for a team switched away from is dropped', ent.currentEntitlements()?.visitLimit === null)
  log('and isn\'t kept under this one', prefs.getLastEntitlements('user', 'team-d')?.visitLimit === null)

  ent.closeEntitlements()
  log('the last answer belongs to the person who asked', prefs.getLastEntitlements('someone-else', 'team-a') === null)
  await ent.openEntitlements('team-a', 'someone-else', new FakeServer().api)
  log('and someone else\'s doesn\'t leave theirs behind', prefs.getLastEntitlements('user', 'team-a') === null)
  log('nor inherit the rest of what the last person had',
    prefs.getLastEntitlements('someone-else', 'team-b') === null, stored.get('fc.session.entitlements'))

  prefs.clearLastEntitlements()
  log('signing out clears them', prefs.getLastEntitlements('someone-else', 'team-a') === null)

  ent.closeEntitlements()
  log('with no team open, asking does nothing', (await ent.refreshEntitlements()) === null)
  stop()
}

// ── After paying ────────────────────────────────────────────────────────────
{
  const heldBy = async (server, ...locations) => {
    cache.resetCache()
    await cache.hydrate(supabaseAdapter('team', 'user', server.api), { device: memoryDevice() })
    await ent.openEntitlements('team', 'user', server.api)
    server.down = true
    for (const [clientId, locationId] of locations) {
      await clientStore.beginVisit(clientId, locationId, 'maintenance', 'Sam')
    }
    server.down = false
    await cache.flush()
  }
  const paid = server => {
    server.visitLimit = null
    server.plan = { isPro: true, plan: 'pro' }
  }

  const server = new FakeServer()
  server.seedClient()
  server.visitLimit = 0
  await heldBy(server, ['c1', 'l1'])
  const [id] = Object.keys(cache.heldVisits())
  log('a visit refused by the plan is waiting', cache.heldVisits()[id]?.reason === 'upgrade')

  paid(server)
  const first = await ent.afterUpgrade()
  log('after paying it is saved', server.visits.has(id) && first.saved === 1, JSON.stringify(first))
  log('and nothing is waiting any more', cache.heldCount() === 0)
  log('the entitlements are fresh', ent.currentEntitlements()?.isPro === true)
  log('it confirms, in the plan\'s words', ent.upgradeConfirmation() === 'You\'re on Pro. Your visit is saved.', ent.upgradeConfirmation())
  ent.dismissUpgradeConfirmation()
  log('which can be dismissed', ent.upgradeConfirmation() === null)

  {
    const server = new FakeServer()
    server.seedClient()
    server.seedClient({ id: 'c2', name: 'Other Co', locationId: 'l2', rooms: ['r9'] })
    server.visitLimit = 0
    await heldBy(server, ['c1', 'l1'], ['c2', 'l2'])
    paid(server)
    await ent.afterUpgrade()
    log('two visits say two', ent.upgradeConfirmation() === 'You\'re on Pro. Your 2 visits are saved.', ent.upgradeConfirmation())
  }
  {
    const server = new FakeServer()
    server.seedClient()
    await heldBy(server)
    paid(server)
    await ent.afterUpgrade()
    log('with nothing waiting it says less', ent.upgradeConfirmation() === 'You\'re on Pro.', ent.upgradeConfirmation())
  }
  {
    // A visit refused for its date isn't waiting on the plan, and paying won't help.
    const server = new FakeServer()
    server.seedClient()
    server.failNext('startVisit', { code: '23514', message: 'The date', hint: 'visit_date', details: null })
    await heldBy(server)
    server.down = true
    await clientStore.beginVisit('c1', 'l1', 'maintenance', 'Sam')
    server.down = false
    await cache.flush()
    const [dated] = Object.keys(cache.heldVisits())
    log('a visit refused over its date is held', cache.heldVisits()[dated]?.reason === 'date')
    const asked = server.countCalls('startVisit')
    paid(server)
    const out = await ent.afterUpgrade()
    log('paying doesn\'t send it again', server.countCalls('startVisit') === asked && !!cache.heldVisits()[dated])
    log('or claim it saved', out.saved === 0 && ent.upgradeConfirmation() === 'You\'re on Pro.', ent.upgradeConfirmation())
  }
  {
    // Refused again: the payment hasn't reached the database yet.
    const server = new FakeServer()
    server.seedClient()
    server.visitLimit = 0
    await heldBy(server, ['c1', 'l1'])
    const out = await ent.afterUpgrade()
    log('not yet on Pro, it doesn\'t say so', ent.upgradeConfirmation() === null)
    log('and the visit stays waiting', out.saved === 0 && cache.heldCount() === 1)
  }
  {
    // Lost the connection on the way back.
    const server = new FakeServer()
    server.seedClient()
    server.visitLimit = 0
    await heldBy(server, ['c1', 'l1'])
    paid(server)
    server.down = true
    const out = await ent.afterUpgrade()
    log('with no connection it claims nothing', out.saved === 0 && ent.upgradeConfirmation() === null)
    server.down = false
    await cache.flush()
    log('and the visit saves when it returns', server.visits.size === 1)
  }
  cache.resetCache()
  ent.closeEntitlements()
}

// ─────────────────────────────────────────────────────────────────────────────
// In a browser: the real screens
// ─────────────────────────────────────────────────────────────────────────────

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
const localhost = new URL(BASE).hostname

async function newDevice(server) {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  await ctx.exposeFunction('__fake', (name, args) => server.call(name, args))
  await ctx.route('**/*', route => {
    const host = new URL(route.request().url()).hostname
    return host === localhost ? route.continue() : route.abort()
  })
  return ctx
}

// What DataBoot does, with the database swapped for the stand-in.
async function connect(page) {
  await page.evaluate(async () => {
    const loaded = path =>
      performance
        .getEntriesByType('resource')
        .map(e => e.name)
        .filter(url => url.includes(path))
        .pop() ?? path
    const cache = await import(loaded('/src/lib/cache.js'))
    const entitlements = await import(loaded('/src/lib/entitlements.js'))
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
    await cache.hydrate(supabaseAdapter('team', 'user', source), { device: deviceCopies('user', 'team') })
    await entitlements.openEntitlements('team', 'user', source)
    window.__plan = entitlements
  })
}

async function open(ctx, address = '#/') {
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(BASE + address, { waitUntil: 'networkidle' })
  await connect(page)
  return page
}

const navLabels = page => page.locator('nav[aria-label="Main"] a').allTextContents()
const mainText = page => page.locator('main').textContent()
const asked = page => page.evaluate(() => window.__plan.refreshEntitlements().then(() => {}))
const address = page => new URL(page.url()).hash
const dialog = page => page.getByRole('dialog')
const dialogs = page => dialog(page).count()
const dialogText = page => dialog(page).textContent()

async function goToSite(page, nav = 'Preventative Maintenance') {
  await page.locator('nav a').filter({ hasText: 'Settings' }).click()
  await page.locator('nav a').filter({ hasText: nav }).click()
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
}

const start = page => page.getByRole('button', { name: /^(Start PM|Start new visit|Upgrade to start)$/ })
const usage = async page => (await mainText(page)).match(/\d+ of \d+ free inspections? used this month · resets 1 \w+/)?.[0] ?? null

try {
  // ── Limits off: nothing tells anyone to upgrade ───────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    server.plan = { visitLimit: 1, visitsUsed: 12 } // a Free team, well past it
    const ctx = await newDevice(server)
    const page = await open(ctx)

    const labels = await navLabels(page)
    log('every page of its packs is there',
      ['Home', 'New Client', 'Edit Client', 'Commissioning', 'Preventative Maintenance', 'Custom List', 'Teams', 'Settings']
        .every(l => labels.includes(l)), labels.join(' | '))
    await goToSite(page)
    log('with the limits off there is no usage line', (await usage(page)) === null)
    log('and Start stays Start', (await page.getByRole('button', { name: /^Start PM$/ }).count()) === 1)
    await start(page).click()
    log('and it starts', await until(() => server.visits.size === 1))
    log('with no sheet', (await dialogs(page)) === 0)
    await page.close()
    await ctx.close()
  }

  // ── The allowance ─────────────────────────────────────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    server.visitLimit = 1
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await goToSite(page)

    log('the visit page shows how much is left',
      /^0 of 1 free inspection used this month · resets 1 \w+$/.test((await usage(page)) ?? ''), await usage(page))
    log('with one left, Start stays Start', (await page.getByRole('button', { name: /^Start PM$/ }).count()) === 1)
    await start(page).click()
    await until(() => server.visits.size === 1)
    log('starting one reads them again', await until(async () => /^1 of 1 /.test((await usage(page)) ?? '')), await usage(page))

    await page.getByRole('button', { name: /^Finish visit$/ }).click()
    await dialog(page).getByRole('button', { name: /^Finish visit$/ }).click()
    log('used up, the button says Upgrade to start',
      await until(async () => (await page.getByRole('button', { name: /^Upgrade to start$/ }).count()) === 1))

    const askedBefore = server.countCalls('startVisit')
    await start(page).click()
    log('pressing it opens the sheet', await until(async () => (await dialogs(page)) === 1))
    log('having asked the database, which said no', server.countCalls('startVisit') === askedBefore + 1)
    const text = await dialogText(page)
    log('the sheet says what happened', /You've used this month's free inspection/.test(text), text)
    log('and when it comes back', /Your next free inspection comes on 1 \w+\./.test(text))
    log('and what Pro adds', /Unlimited inspections/.test(text) && /Photos/.test(text) && /Your logo on reports/.test(text) && /Re-check reminders/.test(text))
    log('and that nothing entered is lost', /Anything you've entered is kept and saves once you upgrade\./.test(text))
    log('with both its buttons',
      (await dialog(page).getByRole('button', { name: 'Upgrade to Pro' }).count()) === 1 &&
      (await dialog(page).getByRole('button', { name: 'Not now' }).count()) === 1)

    await dialog(page).getByRole('button', { name: 'Upgrade to Pro' }).click()
    log('until checkout exists, Upgrade to Pro says so',
      await until(async () => /isn't available yet/.test(await dialogText(page))))
    await dialog(page).getByRole('button', { name: 'Not now' }).click()
    log('Not now closes it', await until(async () => (await dialogs(page)) === 0))
    log('and nothing has opened', (await page.getByRole('button', { name: /^Continue$/ }).count()) === 0)
    log('and nothing was used', server.counted === 1 && server.visits.size === 1, `${server.counted}`)
    log('and it isn\'t held as a visit that didn\'t save', !/Not saved/.test(await mainText(page)))
    await page.close()
    await ctx.close()
  }

  // ── A second device joins with the allowance used up (2.5) ────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    server.visitLimit = 1
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await goToSite(page)

    server.seedVisit({ id: crypto.randomUUID() }) // another device, a moment ago
    await asked(page)
    log('this device sees the allowance has gone',
      await until(async () => (await page.getByRole('button', { name: /^Upgrade to start$/ }).count()) === 1))
    await start(page).click()
    log('Upgrade to start still lets it join',
      await until(async () => /Another device had already started this visit/.test(await mainText(page))))
    log('with no sheet', (await dialogs(page)) === 0)
    log('counted once', server.counted === 1 && server.visits.size === 1, `${server.counted}`)
    log('and it\'s the open visit', (await page.getByRole('button', { name: /^Continue$/ }).count()) === 1)
    await page.close()
    await ctx.close()
  }

  // ── A device whose idea of the allowance is out of date ───────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    server.seedClient({ id: 'c2', name: 'Other Co', locationId: 'l2', rooms: ['r9'] })
    server.visitLimit = 1
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await goToSite(page)

    server.seedVisit({ id: crypto.randomUUID(), locationId: 'l2' }) // used up elsewhere
    log('it still thinks there is one left', /^0 of 1 /.test((await usage(page)) ?? ''))
    await start(page).click()
    log('the database refuses, and it gets the sheet', await until(async () => (await dialogs(page)) === 1))
    log('reading the line again', await until(async () => /^1 of 1 /.test((await usage(page)) ?? '')), await usage(page))
    await page.close()
    await ctx.close()
  }

  // ── Told by the code, never the message ───────────────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await goToSite(page)

    server.failNext('startVisit', { code: '42501', message: 'Please upgrade your plan to Pro', hint: null, details: null })
    await start(page).click()
    log('any other refusal says Save failed', await until(async () => /Save failed/.test(await mainText(page))))
    log('with what went wrong', /Please upgrade your plan to Pro/.test(await mainText(page)))
    log('and no sheet, whatever it said', (await dialogs(page)) === 0)

    server.failNext('startVisit', { code: 'PT402', message: 'Nope', hint: 'upgrade', details: null })
    await start(page).click()
    log('a 402 gets the sheet, whatever it said', await until(async () => (await dialogs(page)) === 1))
    log('and not Save failed', !/Save failed/.test(await mainText(page)))
    await dialog(page).getByRole('button', { name: 'Not now' }).click()

    server.failNext('startVisit', { code: '23514', message: 'The date is wrong', hint: 'visit_date', details: null })
    await start(page).click()
    log('a refused date says Save failed', await until(async () => /Save failed/.test(await mainText(page)) && /The date is wrong/.test(await mainText(page))))
    log('and still no visit', server.visits.size === 0)
    await page.close()
    await ctx.close()
  }

  // ── Refused in the background ─────────────────────────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await goToSite(page)

    await ctx.setOffline(true)
    await start(page).click()
    await until(async () => /Started on this device/.test(await mainText(page)))
    await page.getByRole('button', { name: /^Room r1/ }).click()
    await page.getByRole('button', { name: 'Correct Time and Date: PASS', exact: true }).click()

    server.visitLimit = 0
    await ctx.setOffline(false)
    await until(async () => /1 visit not saved/.test(await page.locator('div.text-right[role="status"]').textContent()))
    await sleep(300)
    log('refused while working in a room: no sheet in the way', (await dialogs(page)) === 0)
    log('and the work is still on screen',
      (await page.getByRole('button', { name: 'Correct Time and Date: PASS', exact: true }).getAttribute('aria-pressed')) === 'true')

    await page.getByRole('button', { name: /^Back|←/ }).first().click()
    await until(async () => /Not saved:/.test(await mainText(page)))
    log('back on the visit page it still doesn\'t open by itself', (await dialogs(page)) === 0)
    const upgrade = page.getByRole('button', { name: 'Upgrade', exact: true })
    log('the notice offers an upgrade', (await upgrade.count()) === 1)
    await upgrade.click()
    log('which opens the sheet', await until(async () => (await dialogs(page)) === 1))
    log('saying the work is kept', /Anything you've entered is kept/.test(await dialogText(page)))
    await dialog(page).getByRole('button', { name: 'Not now' }).click()
    log('and closing it leaves the notice', await until(async () => (await dialogs(page)) === 0) && /Not saved:/.test(await mainText(page)))

    // Paying from here, as step E1 will.
    server.visitLimit = null
    server.plan = { isPro: true, plan: 'pro' }
    await page.evaluate(() => window.__plan.afterUpgrade())
    log('after paying the visit saves', await until(() => server.visits.size === 1))
    log('the notice goes', await until(async () => !/Not saved:/.test(await mainText(page))))
    log('and it says so', /You're on Pro\. Your visit is saved\./.test(await mainText(page)))
    log('the usage line goes too', (await usage(page)) === null)
    await page.getByRole('button', { name: 'Dismiss' }).click()
    log('and the confirmation can be dismissed', await until(async () => !/You're on Pro/.test(await mainText(page))))
    await page.close()
    await ctx.close()
  }
  {
    // A hold that isn't about the plan offers no upgrade.
    const server = new FakeServer()
    server.seedClient()
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await goToSite(page)
    await ctx.setOffline(true)
    await start(page).click()
    await until(async () => /Started on this device/.test(await mainText(page)))
    server.failNext('startVisit', { code: '23514', message: 'The date is wrong', hint: 'visit_date', details: null })
    await ctx.setOffline(false)
    await until(async () => /Not saved:/.test(await mainText(page)))
    log('a visit refused over its date offers no upgrade',
      (await page.getByRole('button', { name: 'Upgrade', exact: true }).count()) === 0 && /The date is wrong/.test(await mainText(page)))
    await page.close()
    await ctx.close()
  }

  // ── A team without a pack ─────────────────────────────────────────────────
  {
    const server = new FakeServer()
    server.seedClient()
    server.plan = { packs: ['core', 'vic_rental'] }
    server.packRefused.add('maintenance')
    const ctx = await newDevice(server)
    const page = await open(ctx)

    const labels = await navLabels(page)
    log('it doesn\'t see that pack\'s pages',
      !labels.includes('Preventative Maintenance') && !labels.includes('Commissioning'), labels.join(' | '))
    log('it still sees everything else',
      ['Home', 'New Client', 'Edit Client', 'Custom List', 'Teams', 'Settings'].every(l => labels.includes(l)))

    await page.goto(BASE + '#/maintenance')
    log('typing the address goes Home', await until(() => address(page) === '#/'), address(page))

    await page.locator('nav a').filter({ hasText: 'Settings' }).click()
    const tabs = page.getByRole('button', { name: /^(Preventative Maintenance|Commissioning|Custom List)$/ })
    log('Settings shows only the lists it holds',
      await until(async () => (await tabs.allTextContents()).join() === 'Custom List'), (await tabs.allTextContents()).join())
    log('with the one it has open', (await tabs.first().getAttribute('aria-pressed')) === 'true')
    await page.close()
    await ctx.close()
  }
  {
    // Losing an add-on: past work stays viewable, and the page says so by opening.
    const server = new FakeServer()
    server.seedClient()
    const old = crypto.randomUUID()
    server.seedVisit({ id: old, completedAt: new Date(Date.now() - 86400000).toISOString() })
    server.plan = { enforced: true, packs: ['core'], visitLimit: null }
    server.packRefused.add('maintenance')
    const ctx = await newDevice(server)
    const page = await open(ctx)

    log('its pages are hidden', !(await navLabels(page)).includes('Preventative Maintenance'))
    await page.goto(BASE + '#/commissioning')
    log('with no visits of that kind, its address goes Home', await until(() => address(page) === '#/'), address(page))
    await page.goto(BASE + '#/maintenance')
    await sleep(300)
    log('with visits of that kind, the page still opens', address(page) === '#/maintenance', address(page))
    await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
    await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
    log('showing what they found', /Last visit completed/.test(await mainText(page)))
    log('its report can still be made', (await page.getByRole('button', { name: 'Export report' }).count()) === 1)
    log('starting a new one says it needs the pack', (await page.getByRole('button', { name: /^Upgrade to start$/ }).count()) === 1)

    await start(page).click()
    log('and the sheet names the pack', await until(async () => (await dialogs(page)) === 1 && /doesn't have the AV/.test(await dialogText(page))))
    log('offering to add it', (await dialog(page).getByRole('button', { name: /^Add AV/ }).count()) === 1)
    log('without talking about inspections', !/inspection/i.test(await dialogText(page)))
    await page.close()
    await ctx.close()
  }

  // ── Landlords and agencies ────────────────────────────────────────────────
  for (const accountType of ['landlord', 'agency']) {
    const server = new FakeServer()
    server.plan = { accountType, packs: ['core'] }
    const ctx = await newDevice(server)
    const page = await open(ctx)

    const labels = await navLabels(page)
    log(`a ${accountType} has its own navigation`,
      labels.join() === 'Properties,Reports,Due,Teams,Settings', labels.join(' | '))
    log('and lands on its properties', await until(() => address(page) === '#/properties'), address(page))
    log('where it can add one', await until(async () => /Add a property/.test(await mainText(page))))
    log('with the header to match', (await page.locator('h1').textContent()) === 'Properties')

    for (const link of ['Reports', 'Due']) {
      await page.locator('nav a').filter({ hasText: new RegExp(`^${link}$`) }).click()
      log(`${link} opens its own page`, await until(async () => (await page.locator('h1').textContent()) === link))
    }

    for (const path of ['#/maintenance', '#/new-client', '#/custom-list', '#/']) {
      await page.goto(BASE + path)
      log(`${path} goes to its properties`, await until(() => address(page) === '#/properties'), address(page))
    }

    await page.goto(BASE + '#/settings')
    await until(async () => /Company/.test(await mainText(page)))
    const settings = await mainText(page)
    log('Settings has no test lists or technician', !/Test lists/.test(settings) && !/Default technician/.test(settings))
    log('but keeps its company details', /Company name/.test(settings))
    await page.close()
    await ctx.close()
  }
  {
    const server = new FakeServer()
    const ctx = await newDevice(server)
    const page = await open(ctx)
    await page.goto(BASE + '#/properties')
    log('an inspecting team has no landlord pages', await until(() => address(page) === '#/'), address(page))
    log('and none in its navigation', !(await navLabels(page)).includes('Properties'))
    await page.close()
    await ctx.close()
  }
  {
    // Not knowing hides nothing: the headless suites, or a project without the function.
    const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
    const page = await ctx.newPage()
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(BASE + '#/maintenance', { waitUntil: 'networkidle' })
    log('with nothing known every page opens', address(page) === '#/maintenance', address(page))
    const labels = await navLabels(page)
    log('and every inspector\'s page is there',
      ['Commissioning', 'Preventative Maintenance', 'Custom List'].every(l => labels.includes(l)), labels.join(' | '))
    await page.goto(BASE + '#/settings')
    log('Settings has every list',
      await until(async () => (await page.getByRole('button', { name: /^(Preventative Maintenance|Commissioning|Custom List)$/ }).count()) === 3))
    await page.close()
    await ctx.close()
  }

  // ── The banners ───────────────────────────────────────────────────────────
  {
    const soon = days => new Date(Date.now() + days * 86400000).toISOString()
    const server = new FakeServer()
    server.seedClient()
    server.plan = { isPro: true, plan: 'pro', pastDueUntil: soon(5) }
    const ctx = await newDevice(server)
    const page = await open(ctx)

    log('a declined card shows on every page, with its deadline',
      await until(async () => /Update the card by \d+ \w+, or this team moves to the Free plan\./.test(await mainText(page))))
    await page.locator('nav a').filter({ hasText: 'Edit Client' }).click()
    log('whichever page that is', /Update the card by/.test(await mainText(page)))

    server.plan = { isPro: true, plan: 'pro', pastDueUntil: soon(-1) }
    await asked(page)
    log('and goes once the deadline passes', await until(async () => !/Update the card/.test(await mainText(page))))

    server.plan = { isPro: true, plan: 'pro', cancelAt: soon(13) }
    await asked(page)
    log('a plan ending says when', await until(async () => /Pro ends on \d+ \w+\./.test(await mainText(page))))
    log('with no open visits it asks nothing more', !/Finish these open visits/.test(await mainText(page)))

    await goToSite(page)
    await start(page).click()
    log('with an open visit it lists it',
      await until(async () => /Finish these open visits before then:/.test(await mainText(page)) && /Equinix · 8 Grand Avenue, Rosehill/.test(await mainText(page))))

    await page.locator('nav a').filter({ hasText: 'Settings' }).click()
    await page.getByRole('link', { name: /Equinix · 8 Grand Avenue/ }).click()
    log('and the list goes straight to it',
      await until(async () => address(page) === '#/maintenance' && (await page.getByRole('button', { name: /^Continue$/ }).count()) === 1), address(page))

    await page.getByRole('button', { name: /^Finish visit$/ }).click()
    await dialog(page).getByRole('button', { name: /^Finish visit$/ }).click()
    log('finishing it takes it off the list',
      await until(async () => !/Finish these open visits/.test(await mainText(page)) && /Pro ends on/.test(await mainText(page))))
    await page.close()
    await ctx.close()
  }

  // ── Who can do something about it, and the Teams page ─────────────────────
  {
    let members = []
    let teamsAnswers = {}
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
    const answer = (route, status, body) =>
      route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })

    const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
    await ctx.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.hostname === localhost) return route.continue()
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      const said = teamsAnswers[url.pathname.split('/').pop()]
      if (url.pathname.endsWith('/team_members_list')) return answer(route, 200, members)
      if (url.pathname.endsWith('/all_members_overview')) return answer(route, 200, [])
      if (url.pathname.endsWith('/list_invites') || url.pathname.endsWith('/team_invites')) return answer(route, 200, [])
      return said ? answer(route, said.status, said.body) : route.abort()
    })
    const page = await ctx.newPage()
    page.on('pageerror', e => pageErrors.push(e.message))
    await page.goto(BASE + '#/', { waitUntil: 'networkidle' })

    const mountSheet = role =>
      page.evaluate(async role => (await import('/tests/fixtures/mount-plan-pages.jsx')).mountSheet(role), role)

    await mountSheet('admin')
    log('an admin gets Upgrade to Pro', (await dialog(page).getByRole('button', { name: 'Upgrade to Pro' }).count()) === 1)
    log('and isn\'t told to ask anyone', !/Ask /.test(await dialogText(page)))

    await mountSheet('owner')
    log('so does an owner', (await dialog(page).getByRole('button', { name: 'Upgrade to Pro' }).count()) === 1)

    await mountSheet('member')
    log('a member doesn\'t', (await dialog(page).getByRole('button', { name: 'Upgrade to Pro' }).count()) === 0)
    log('and can only close it', (await dialog(page).getByRole('button', { name: 'Close' }).count()) === 1)
    log('with no answer it says who in general',
      await until(async () => /Ask your team's owner or an admin to upgrade\./.test(await dialogText(page))))
    log('still explaining what happened', /Your next free inspection comes on/.test(await dialogText(page)))

    const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
    if (!configured) {
      console.log('(the checks against real requests need VITE_SUPABASE_URL in .env, and were skipped)')
    } else {
      members = [
        { user_id: 'a', email: 'admin@example.com', role: 'admin', joined_at: null },
        { user_id: 'b', email: 'tech@example.com', role: 'member', joined_at: null },
        { user_id: 'c', email: 'owner@example.com', role: 'owner', joined_at: null },
      ]
      await mountSheet('member')
      log('a member is told who to ask, owner first',
        await until(async () => /Ask owner@example\.com or admin@example\.com to upgrade\./.test(await dialogText(page))), await dialogText(page))
      log('and never another member', !/tech@example\.com/.test(await dialogText(page)))

      // The Teams page, with a real request behind each button.
      const full = { status: 400, body: { error: 'Every seat on this team\'s plan is taken or already invited (1 of 1)', code: 'PT402', hint: 'upgrade' } }
      const free = { status: 200, body: { is_pro: false, packs: ['core'], account_type: 'provider' } }
      const invite = async () => {
        await page.getByLabel(/Email/).fill('new@example.com')
        await page.getByRole('button', { name: 'Invite', exact: true }).click()
      }
      await page.evaluate(async () => (await import('/tests/fixtures/mount-plan-pages.jsx')).mountTeams('owner'))
      await page.getByRole('button', { name: 'Edit', exact: true }).click()

      teamsAnswers = { 'send-invite': full, team_entitlements: free }
      await invite()
      log('inviting into a full team gets the sheet', await until(async () => (await dialogs(page)) === 1))
      log('saying which team is full', /Northpoint is full/.test(await dialogText(page)), await dialogText(page))
      log('offering Pro on Free', (await dialog(page).getByRole('button', { name: 'Upgrade to Pro' }).count()) === 1)
      log('and not promising anything entered is kept', !/Anything you've entered/.test(await dialogText(page)))
      await dialog(page).getByRole('button', { name: 'Not now' }).click()

      teamsAnswers = { 'send-invite': full, team_entitlements: { status: 200, body: { is_pro: true, packs: ['core'] } } }
      await invite()
      log('on Pro it offers seats', await until(async () => (await dialogs(page)) === 1 && (await dialog(page).getByRole('button', { name: 'Add seats' }).count()) === 1))
      await dialog(page).getByRole('button', { name: 'Not now' }).click()

      teamsAnswers = { 'send-invite': { status: 400, body: { error: 'They could upgrade to Pro, but that person is already in this team' } } }
      await invite()
      log('any other refusal says what went wrong',
        await until(async () => /that person is already in this team/.test(await page.textContent('body'))))
      log('with no sheet, whatever it said', (await dialogs(page)) === 0)

      // No Edge Function to be had: the direct request refuses the same way.
      teamsAnswers = {
        create_invite: { status: 402, body: { code: 'PT402', message: 'Every seat is taken', details: null, hint: 'upgrade' } },
        team_entitlements: free,
      }
      await invite()
      log('with no Edge Function the refusal is still told by its code',
        await until(async () => (await dialogs(page)) === 1 && /is full/.test(await dialogText(page))))
      await dialog(page).getByRole('button', { name: 'Not now' }).click()

      // What the real function answers in the shape PostgREST sends.
      const read = () =>
        page.evaluate(async () => {
          const api = await import('/src/lib/api.js')
          try {
            return { data: await api.getEntitlements('team') }
          } catch (e) {
            return { error: { code: e.code, message: e.message } }
          }
        })
      teamsAnswers = {
        team_entitlements: {
          status: 200,
          body: {
            enforced: true, account_type: 'agency', plan: 'pro', is_pro: true, seat_limit: 5, seats_used: 2,
            visit_limit: null, visits_used: 3, packs: ['core', 'av'], past_due_until: '2026-11-09T00:00:00+00:00',
            cancel_at: '2026-11-15T00:00:00+00:00', import_used: true, open_visits: 4,
          },
        },
      }
      const row = (await read()).data
      log('the row reaches the app in its own words',
        row?.enforced === true && row.accountType === 'agency' && row.isPro === true && row.seatLimit === 5 && row.seatsUsed === 2 &&
        row.visitLimit === null && row.visitsUsed === 3 && row.packs.join() === 'core,av' && !!row.pastDueUntil && !!row.cancelAt &&
        row.importUsed === true && row.openVisits === 4, JSON.stringify(row))
      teamsAnswers = { team_entitlements: { status: 200, body: null } }
      log('not being in the team is no answer, not an error', (await read()).data === null)
      teamsAnswers = { team_entitlements: { status: 404, body: { code: 'PGRST202', message: 'no such function', details: null, hint: null } } }
      log('a project without the function comes back as its error', (await read()).error?.code === 'PGRST202')
    }
    await page.close()
    await ctx.close()
  }

  log('no script errors on any page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}
