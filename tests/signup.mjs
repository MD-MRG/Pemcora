/**
 * Signing up: what a new team is asked, and what it's given (build plan B5, 2.3).
 *
 * The rules run in Node first. Then Team Setup and the Teams page run for real in a
 * browser, and the suite reads back what they asked the server to create. What the
 * server does with that is in docs/editions/test/run_tests.py, against real Postgres.
 *
 * What it holds the app to:
 *   - every row of the starter table in 2.3 leads to the right pack, and a landlord
 *     to none
 *   - a team confirms its pack, can change it, and takes no add-on unless it says so
 *   - nothing can be chosen that isn't ready: the unchecked electrical packs, and
 *     landlord pages that don't exist yet
 *   - a pack can be swapped while it's unused, and the choice goes when it's used
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'
import { FakeServer } from './fake-server.mjs'

const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') =>
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function until(check, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// In Node: the rules
// ─────────────────────────────────────────────────────────────────────────────

const signup = await import('../src/lib/signup.js')
const { PACKS, offeredPacks, packById } = await import('../src/data/packs/index.js')
const ent = await import('../src/lib/entitlements.js')
const { readFileSync } = await import('node:fs')

const { starterPackFor, tradeIsOpen, stateIsOpen, TRADES, STATES, OPEN_NOW } = signup
const trade = id => TRADES.find(t => t.id === id)

{
  log('AV integration starts on av, in any state', STATES.every(s => starterPackFor('av', s.id) === 'av') && starterPackFor('av') === 'av')
  log('electrical work in Victoria starts on vic_rental', starterPackFor('electrical', 'VIC') === 'vic_rental')
  log('in Queensland, on qld_electrical', starterPackFor('electrical', 'QLD') === 'qld_electrical')
  const others = STATES.filter(s => !['VIC', 'QLD'].includes(s.id))
  log('in every other state, on electrical_general', others.length === 6 && others.every(s => starterPackFor('electrical', s.id) === 'electrical_general'), others.map(s => s.id).join())
  log('a landlord gets no pack', starterPackFor('landlord', 'VIC') === null && starterPackFor('landlord') === null)
  log('nor does property management', starterPackFor('property', 'VIC') === null)
  log('a landlord is a landlord to the database', trade('landlord').accountType === 'landlord')
  log('property management is an agency', trade('property').accountType === 'agency')
  log('and the rest are providers', trade('av').accountType === 'provider' && trade('electrical').accountType === 'provider')
  log('only electrical work asks for a state', TRADES.filter(t => t.asksState).map(t => t.id).join() === 'electrical')

  const packs = new Set(PACKS.map(p => p.id))
  log('every pack it can lead to exists', [...STATES.map(s => starterPackFor('electrical', s.id)), 'av'].every(id => packs.has(id)))

  // Every state the database accepts, and only those.
  const sql = readFileSync(new URL('../supabase/migrations/0008_signup.sql', import.meta.url), 'utf8')
  const allowed = sql.match(/state in \(([^)]*)\)/)[1].match(/'([A-Z]+)'/g).map(s => s.slice(1, -1)).sort()
  log('the states match the database\'s list', same(allowed, STATES.map(s => s.id).sort()), allowed.join())
}

{
  log('on the live site, AV can be chosen', tradeIsOpen(trade('av')))
  log('electrical can\'t, until its lists are checked', !tradeIsOpen(trade('electrical')))
  log('landlords can\'t, until they have pages', !tradeIsOpen(trade('landlord')))
  log('nor property managers', !tradeIsOpen(trade('property')))
  log('and no state is open', STATES.every(s => !stateIsOpen(s.id)))

  // Each one opens by itself, as its pack is signed off, and not before.
  const vicOnly = { ...OPEN_NOW, pack: pack => !pack.proposed || pack.id === 'vic_rental' }
  log('one pack signed off opens electrical work', tradeIsOpen(trade('electrical'), vicOnly))
  log('in that state', stateIsOpen('VIC', vicOnly))
  log('and no other', !stateIsOpen('QLD', vicOnly) && !stateIsOpen('NSW', vicOnly))
  log('step D4\'s switch opens both kinds of landlord',
    tradeIsOpen(trade('landlord'), { ...OPEN_NOW, receiving: true }) && tradeIsOpen(trade('property'), { ...OPEN_NOW, receiving: true }))
}

{
  const provider = (over = {}) => ({ accountType: 'provider', starterPack: 'vic_rental', starterInUse: false, packs: ['core', 'vic_rental'], ...over })
  log('an unused starter can be swapped for what is on offer',
    same(ent.swapTargets(provider()).map(p => p.id), offeredPacks().map(p => p.id)), ent.swapTargets(provider()).map(p => p.id).join())
  log('only ever a pack that is on offer', offeredPacks().every(p => !p.proposed && p.id !== 'core'))
  log('not a pack it already holds', ent.swapTargets(provider({ packs: ['core', 'vic_rental', 'av'] })).length === 0)
  log('not once it\'s been used', ent.swapTargets(provider({ starterInUse: true })).length === 0)
  log('not with no starter: a landlord, or a pack granted free', ent.swapTargets(provider({ starterPack: null })).length === 0)
  log('not when nothing is known', ent.swapTargets(null).length === 0)

  const sheet = ent.visitSheet(provider(), 'maintenance')
  log('the pack sheet offers the swap', sheet.swap?.packId === 'av', JSON.stringify(sheet.swap))
  log('naming the pack it replaces', /Victorian rental safety checks/.test(sheet.swap?.line ?? ''))
  log('used up, it doesn\'t', ent.visitSheet(provider({ starterInUse: true }), 'maintenance').swap === null)
  log('nor does the allowance sheet', !ent.visitSheet(provider({ packs: ['core', 'av'], starterPack: 'av' }), 'maintenance').swap)
  const label = id => packById(id)?.label
  log('a team that holds the pack through its starter has nothing to swap to', label('av') && ent.swapTargets(provider({ starterPack: 'av', packs: ['core', 'av'] })).length === 0)
}

{
  const t = ent.brandTagline
  log('an AV team still reads AV Service', t({ accountType: 'provider', starterPack: 'av', packs: ['core', 'av'] }) === 'AV Service')
  log('so does one whose AV was granted free', t({ accountType: 'provider', starterPack: null, packs: ['core', 'av'] }) === 'AV Service')
  for (const id of ['vic_rental', 'qld_electrical', 'electrical_general']) {
    log(`${id} reads Electrical compliance`, t({ accountType: 'provider', starterPack: id, packs: ['core', id] }) === 'Electrical compliance')
  }
  log('an electrician with AV as an add-on still reads as one',
    t({ accountType: 'provider', starterPack: 'vic_rental', packs: ['core', 'av', 'vic_rental'] }) === 'Electrical compliance')
  log('a landlord reads Property compliance', t({ accountType: 'landlord', starterPack: null, packs: ['core'] }) === 'Property compliance')
  log('so does an agency', t({ accountType: 'agency', starterPack: null, packs: ['core'] }) === 'Property compliance')
  log('with nothing known it claims nothing', t(null) === 'Inspections and reports')
  log('nor with only core', t({ accountType: 'provider', starterPack: null, packs: ['core'] }) === 'Inspections and reports')
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

const FIXTURE = '/tests/fixtures/mount-plan-pages.jsx'

const mountSetup = (page, options) =>
  page.evaluate(async ({ FIXTURE, options }) => (await import(FIXTURE)).mountTeamSetup(options), { FIXTURE, options })
const createdTeams = page => page.evaluate(() => window.__created)
const radio = (page, name) => page.getByRole('radio', { name })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const bodyText = page => page.textContent('body')

// Answers the questions and stops at the confirmation.
async function answer(page, tradeLabel, state) {
  await radio(page, new RegExp(`^${tradeLabel}`)).check()
  if (state) await page.getByRole('combobox').selectOption(state)
  await button(page, 'Continue').click()
}

try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  await ctx.route('**/*', route => {
    const host = new URL(route.request().url()).hostname
    return host === localhost ? route.continue() : route.abort()
  })
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })

  // ── As the live site has it ───────────────────────────────────────────────
  await mountSetup(page)
  log('a new person is asked what their team does', /What does your team do\?/.test(await bodyText(page)))
  log('and nothing has been created yet', (await createdTeams(page)).length === 0)
  log('AV integration can be chosen', await radio(page, /^AV integration/).isEnabled())
  for (const label of ['Electrical work', 'Landlord', 'Property management']) {
    log(`${label} says Coming soon, and can't be chosen`, await radio(page, new RegExp(`^${label}`)).isDisabled())
  }
  log('saying so three times', ((await bodyText(page)).match(/Coming soon/g) ?? []).length === 3)
  log('Continue waits for an answer', await button(page, 'Continue').isDisabled())
  log('and they can still sign out', (await button(page, 'Sign out').count()) === 1)

  await radio(page, /^AV integration/).check()
  log('no state is asked for AV', (await page.getByRole('combobox').count()) === 0)
  await button(page, 'Continue').click()
  log('the next screen shows the matched pack', /Your starter pack/.test(await bodyText(page)) && /AV maintenance and commissioning/.test(await bodyText(page)))
  log('with nothing else on offer, there is nothing to change it to', (await button(page, 'Change').count()) === 0)
  log('and no add-ons to choose', !/Add another pack/.test(await bodyText(page)))
  log('but packs can still be added later', /You can add packs any time\./.test(await bodyText(page)))
  await button(page, 'Create team').click()
  const av = (await createdTeams(page))[0]
  log('confirming asks for the right team',
    av?.accountType === 'provider' && av.packId === 'av' && av.state === null && same(av.addons, []), JSON.stringify(av))
  log('named after the person', av?.name === 'Sam\'s team', av?.name)

  // ── Every row of the table in 2.3 ─────────────────────────────────────────
  const rows = [
    ['AV integration', null, 'provider', 'av', null, 'AV maintenance and commissioning'],
    ['Electrical work', 'VIC', 'provider', 'vic_rental', 'VIC', 'Victorian rental safety checks'],
    ['Electrical work', 'QLD', 'provider', 'qld_electrical', 'QLD', 'Queensland electrical and smoke alarm compliance'],
    ...['NSW', 'ACT', 'SA', 'WA', 'TAS', 'NT'].map(s => ['Electrical work', s, 'provider', 'electrical_general', s, 'Electrical compliance baseline']),
    ['Landlord', null, 'landlord', null, null, null],
    ['Property management', null, 'agency', null, null, null],
  ]
  for (const [tradeLabel, state, accountType, packId, sentState, packLabel] of rows) {
    await mountSetup(page, { allOpen: true })
    const before = (await createdTeams(page)).length
    await answer(page, tradeLabel, state)
    const shown = packLabel ? (await bodyText(page)).includes(packLabel) : /doesn't\s+need a pack/.test(await bodyText(page))
    await button(page, 'Create team').click()
    const made = (await createdTeams(page))[before]
    log(`${tradeLabel}${state ? ` in ${state}` : ''} is shown and creates the right team`,
      shown && made?.accountType === accountType && made.packId === packId && made.state === sentState && same(made.addons, []),
      JSON.stringify(made))
  }

  // ── The questions ─────────────────────────────────────────────────────────
  await mountSetup(page, { allOpen: true })
  await radio(page, /^Electrical work/).check()
  log('electrical work asks which state', /Which state is it in\?/.test(await bodyText(page)))
  log('Continue waits for that too', await button(page, 'Continue').isDisabled())
  await page.getByRole('combobox').selectOption('VIC')
  log('and goes on once it\'s chosen', await button(page, 'Continue').isEnabled())
  await radio(page, /^AV integration/).check()
  log('switching away drops the state question', (await page.getByRole('combobox').count()) === 0)
  await radio(page, /^Electrical work/).check()
  log('and coming back doesn\'t keep the old answer', await button(page, 'Continue').isDisabled())
  await page.getByRole('combobox').selectOption('QLD')
  await button(page, 'Continue').click()
  await button(page, 'Back').click()
  log('Back keeps the answers', await radio(page, /^Electrical work/).isChecked() && (await page.getByRole('combobox').inputValue()) === 'QLD')

  // ── Changing the match ────────────────────────────────────────────────────
  await button(page, 'Continue').click()
  log('with others on offer, the match can be changed', (await button(page, 'Change').count()) === 1)
  await button(page, 'Change').click()
  const choosing = page.getByRole('group', { name: 'Choose your starter pack' })
  log('to any pack', (await choosing.getByRole('radio').count()) === 4)
  log('starting from the match', await choosing.getByRole('radio', { name: 'Queensland electrical and smoke alarm compliance' }).isChecked())
  log('and never core', !/Core/.test(await choosing.textContent()))
  await choosing.getByRole('radio', { name: 'Electrical compliance baseline' }).check()
  await button(page, 'Create team').click()
  const changed = (await createdTeams(page)).at(-1)
  log('the change is what gets created, in the state they said',
    changed.packId === 'electrical_general' && changed.state === 'QLD', JSON.stringify(changed))

  await mountSetup(page, { allOpen: true })
  await answer(page, 'Electrical work', 'VIC')
  await button(page, 'Change').click()
  await page.getByRole('group', { name: 'Choose your starter pack' }).getByRole('radio', { name: 'AV maintenance and commissioning' }).check()
  await button(page, 'Back').click()
  await page.getByRole('combobox').selectOption('NSW')
  await button(page, 'Continue').click()
  log('answering differently starts from the new match', /Electrical compliance baseline/.test(await page.locator('p.text-\\[15px\\]').textContent()))

  // ── Add-ons ───────────────────────────────────────────────────────────────
  await mountSetup(page, { allOpen: true })
  await answer(page, 'Electrical work', 'VIC')
  const addons = page.getByRole('group', { name: 'Add another pack?' })
  const none = addons.getByRole('checkbox', { name: 'No add-on' })
  const avAddon = addons.getByRole('checkbox', { name: 'AV maintenance and commissioning' })
  const qldAddon = addons.getByRole('checkbox', { name: 'Queensland electrical and smoke alarm compliance' })
  log('the other packs are offered as add-ons', (await addons.getByRole('checkbox').count()) === 4)
  log('not the starter', (await addons.getByRole('checkbox', { name: 'Victorian rental safety checks' }).count()) === 0)
  log('No add-on is selected to begin with', await none.isChecked())
  log('and the line about adding packs later', /You can add packs any time\./.test(await bodyText(page)))
  log('nothing says add-ons are on sale', !/aren't on sale/.test(await bodyText(page)))

  await avAddon.check()
  log('choosing one takes No add-on off', !(await none.isChecked()))
  log('and says it\'s only noted for now', /Add-ons aren't on sale yet\. We'll note your choice/.test(await bodyText(page)))
  await qldAddon.check()
  await none.check()
  log('No add-on clears them', await none.isChecked() && !(await avAddon.isChecked()) && !(await qldAddon.isChecked()))
  await avAddon.check()
  await qldAddon.check()

  await button(page, 'Change').click()
  await page.getByRole('group', { name: 'Choose your starter pack' }).getByRole('radio', { name: 'AV maintenance and commissioning' }).check()
  log('an add-on chosen as the starter stops being an add-on',
    (await addons.getByRole('checkbox', { name: 'AV maintenance and commissioning' }).count()) === 0)
  await button(page, 'Create team').click()
  const withAddons = (await createdTeams(page)).at(-1)
  log('add-ons go with the team', withAddons.packId === 'av' && same(withAddons.addons, ['qld_electrical']), JSON.stringify(withAddons))

  await mountSetup(page, { allOpen: true })
  await answer(page, 'Landlord')
  log('a landlord isn\'t offered packs', !/Add another pack|Your starter pack|You can add packs/.test(await bodyText(page)))

  // ── When it doesn't work ──────────────────────────────────────────────────
  await mountSetup(page)
  await answer(page, 'AV integration')
  await page.evaluate(() => {
    window.__answer = { error: { message: 'The database said no' } }
  })
  await button(page, 'Create team').click()
  log('a failure says why', await until(async () => /The database said no/.test(await bodyText(page))))
  log('and it can be tried again', await button(page, 'Create team').isEnabled())
  await page.evaluate(() => {
    window.__answer = null
  })
  const tries = (await createdTeams(page)).length
  await button(page, 'Create team').click()
  log('trying again makes the call', await until(async () => (await createdTeams(page)).length === tries + 1))
  log('and the message goes', await until(async () => !/The database said no/.test(await bodyText(page))))

  // ── The Teams page uses the same questions ────────────────────────────────
  const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
  await page.evaluate(async FIXTURE => (await import(FIXTURE)).mountTeams('owner'), FIXTURE)
  await until(async () => /Create a team/.test(await bodyText(page)))
  log('making another team asks too', /What does your team do\?/.test(await bodyText(page)))
  log('so it can\'t get AV without asking', (await radio(page, /^AV integration/).isChecked()) === false)
  await page.getByLabel('Team name').fill('Second Team')
  await page.getByLabel('Description').fill('The other half')
  await answer(page, 'AV integration')
  const before = (await createdTeams(page)).length
  await page.getByLabel('Team name').fill('')
  log('it needs a name', await button(page, 'Create team').isDisabled())
  await page.getByLabel('Team name').fill('Second Team')
  await button(page, 'Create team').click()
  const second = (await createdTeams(page))[before]
  log('with its name, description and answers',
    second?.name === 'Second Team' && second.description === 'The other half' && second.packId === 'av' && second.accountType === 'provider',
    JSON.stringify(second))
  log('and the form starts again for the next one',
    await until(async () => (await page.getByLabel('Team name').inputValue()) === '' && /What does your team do\?/.test(await bodyText(page))))

  // ── What goes to the server ───────────────────────────────────────────────
  if (!configured) {
    console.log('(the checks against real requests need VITE_SUPABASE_URL in .env, and were skipped)')
  } else {
    let sent = null
    let reply = { status: 200, body: { id: 'new-team', name: 'x' } }
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
    await ctx.route('**/rest/v1/rpc/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      sent = { path: new URL(route.request().url()).pathname.split('/').pop(), body: route.request().postDataJSON() }
      return route.fulfill({ status: reply.status, contentType: 'application/json', headers: cors, body: JSON.stringify(reply.body) })
    })
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

    await call('createOrganisation', [{ name: 'Sparks', description: 'Sparks co', accountType: 'provider', packId: 'vic_rental', state: 'VIC', addons: ['av'] }])
    log('sign-up calls create_organisation with all six arguments',
      sent?.path === 'create_organisation' && same(sent.body, {
        p_name: 'Sparks', p_account_type: 'provider', p_pack_id: 'vic_rental', p_description: 'Sparks co', p_state: 'VIC', p_addons: ['av'],
      }), JSON.stringify(sent))
    await call('createOrganisation', [{ name: 'Rentals', accountType: 'landlord' }])
    log('a landlord still sends all six, so it means the same function',
      same(sent?.body, { p_name: 'Rentals', p_account_type: 'landlord', p_pack_id: null, p_description: '', p_state: null, p_addons: [] }), JSON.stringify(sent))
    reply = { status: 400, body: { code: 'P0001', message: 'Choose the pack this team starts with', details: null, hint: null } }
    const refused = await call('createOrganisation', [{ name: 'x', accountType: 'provider' }])
    log('a refusal comes back with its message', /Choose the pack/.test(refused.error?.message ?? ''), JSON.stringify(refused))
    reply = { status: 200, body: null }
    await call('chooseStarterPack', ['team', 'av'])
    log('swapping calls choose_starter_pack', sent?.path === 'choose_starter_pack' && same(sent.body, { p_team_id: 'team', p_pack_id: 'av' }), JSON.stringify(sent))
    reply = { status: 402, body: { code: 'PT402', message: 'cannot be swapped', details: null, hint: 'upgrade' } }
    log('and a used pack comes back refused', (await call('chooseStarterPack', ['team', 'av'])).error?.code === 'PT402')
    reply = { status: 200, body: { packs: ['core', 'av'], starter_pack: 'av', starter_in_use: true } }
    const row = (await call('getEntitlements', ['team'])).data
    log('the starter reaches the app', row?.starterPack === 'av' && row.starterInUse === true, JSON.stringify(row))
    reply = { status: 200, body: { packs: ['core', 'av'] } }
    const older = (await call('getEntitlements', ['team'])).data
    log('from before 0008 it just isn\'t there', older?.starterPack === null && older.starterInUse === false, JSON.stringify(older))
    await ctx.unroute('**/rest/v1/rpc/**')
  }
  await page.close()
  await ctx.close()

  // ── Changing a pack afterwards ────────────────────────────────────────────
  const device = async server => {
    const context = await testContext(browser, { viewport: { width: 1280, height: 900 } })
    await context.exposeFunction('__fake', (name, args) => server.call(name, args))
    await context.route('**/*', route => {
      const host = new URL(route.request().url()).hostname
      return host === localhost ? route.continue() : route.abort()
    })
    const p = await context.newPage()
    p.on('pageerror', e => pageErrors.push(e.message))
    await p.goto(BASE + '#/settings', { waitUntil: 'networkidle' })
    await p.evaluate(async () => {
      const loaded = path =>
        performance.getEntriesByType('resource').map(e => e.name).filter(url => url.includes(path)).pop() ?? path
      const cache = await import(loaded('/src/lib/cache.js'))
      const entitlements = await import(loaded('/src/lib/entitlements.js'))
      const { supabaseAdapter } = await import(loaded('/src/lib/adapters/supabase.js'))
      const source = new Proxy(
        {},
        {
          get: (_, name) => async (...args) => {
            const { data, error } = await window.__fake(name, args)
            if (error) throw error.thrown ? Object.assign(new Error(error.message), error) : error
            return data
          },
        },
      )
      cache.resetCache()
      await cache.hydrate(supabaseAdapter('team', 'user', source), {})
      await entitlements.openEntitlements('team', 'user', source)
      window.__plan = entitlements
    })
    return { context, p }
  }
  const navLabels = p => p.locator('nav[aria-label="Main"] a').allTextContents()
  const yourPack = p => p.getByRole('heading', { name: 'Your pack' })
  const plate = async p => (await p.locator('span.uppercase').first().textContent()).trim()

  {
    const server = new FakeServer()
    server.plan = { starterPack: 'vic_rental', packs: ['core', 'vic_rental'] }
    const { context, p } = await device(server)
    log('a team on the wrong pack can see it in Settings', await until(async () => (await yourPack(p).count()) === 1))
    log('saying what it is, and for how long', /Victorian rental safety checks is this team's starter pack/.test(await bodyText(p)))
    log('the plate says what it does', (await plate(p)) === 'Electrical compliance', await plate(p))
    log('its AV pages are hidden', !(await navLabels(p)).includes('Preventative Maintenance'))
    log('nothing is chosen for it', await button(p, 'Change pack').isDisabled())
    await p.getByRole('group', { name: 'Change it to' }).getByRole('radio', { name: 'AV maintenance and commissioning' }).check()
    await button(p, 'Change pack').click()
    log('changing it reaches the database', await until(() => server.plan.starterPack === 'av'))
    log('and the pages follow', await until(async () => (await navLabels(p)).includes('Preventative Maintenance')), (await navLabels(p)).join(' | '))
    log('so does the plate', await until(async () => (await plate(p)) === 'AV Service'), await plate(p))
    log('and with nothing left to change to, the card goes', await until(async () => (await yourPack(p).count()) === 0))
    await context.close()
  }
  {
    const server = new FakeServer()
    server.plan = { starterPack: 'vic_rental', packs: ['core', 'vic_rental'] }
    const { context, p } = await device(server)
    await until(async () => (await yourPack(p).count()) === 1)
    server.plan = { ...server.plan, starterInUse: true }
    await p.getByRole('group', { name: 'Change it to' }).getByRole('radio', { name: 'AV maintenance and commissioning' }).check()
    await button(p, 'Change pack').click()
    log('used on another device in the meantime, it says so',
      await until(async () => /cannot be swapped/.test(await bodyText(p))))
    log('and the pack stays', server.plan.starterPack === 'vic_rental')
    await p.evaluate(() => window.__plan.refreshEntitlements())
    log('the card goes once it knows', await until(async () => (await yourPack(p).count()) === 0))
    await context.close()
  }
  for (const [what, plan] of [
    ['an AV team with nothing else on offer', { starterPack: 'av', packs: ['core', 'av'] }],
    ['a team whose pack was granted free', { starterPack: null, packs: ['core', 'av'] }],
    ['a landlord', { accountType: 'landlord', starterPack: null, packs: ['core'] }],
  ]) {
    const server = new FakeServer()
    server.plan = plan
    const { context, p } = await device(server)
    await sleep(300)
    log(`${what} isn't shown the card`, (await yourPack(p).count()) === 0)
    await context.close()
  }
  {
    // From the sheet, on a page kept for past work.
    const server = new FakeServer()
    server.seedClient()
    server.seedVisit({ id: crypto.randomUUID(), completedAt: new Date(Date.now() - 86400000).toISOString() })
    server.plan = { enforced: true, visitLimit: null, starterPack: 'vic_rental', packs: ['core', 'vic_rental'] }
    server.packRefused.add('maintenance')
    const { context, p } = await device(server)
    await p.goto(BASE + '#/maintenance')
    await p.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
    await p.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
    await button(p, 'Upgrade to start').click()
    await until(async () => (await p.getByRole('dialog').count()) === 1)
    const dialog = p.getByRole('dialog')
    log('the sheet offers the swap', (await dialog.getByRole('button', { name: /^Swap to AV/ }).count()) === 1, await dialog.textContent())
    log('as well as adding the pack', (await dialog.getByRole('button', { name: /^Add AV/ }).count()) === 1)
    log('saying what it would replace', /Victorian rental safety checks/.test(await dialog.textContent()))
    await dialog.getByRole('button', { name: /^Swap to AV/ }).click()
    log('swapping closes the sheet', await until(async () => (await p.getByRole('dialog').count()) === 0))
    log('and the visit can start', await until(async () => (await p.getByRole('button', { name: /^Start new visit$/ }).count()) === 1))
    log('reaching the database', server.plan.starterPack === 'av')
    await p.getByRole('button', { name: /^Start new visit$/ }).click()
    log('and it does', await until(async () => (await p.getByRole('button', { name: /^Continue$/ }).count()) === 1))
    await context.close()
  }
  {
    // A member can't: the card isn't theirs, and neither is the swap.
    const server = new FakeServer()
    server.plan = { starterPack: 'vic_rental', packs: ['core', 'vic_rental'] }
    const { context, p } = await device(server)
    await p.evaluate(async FIXTURE => (await import(FIXTURE)).mountStarterCard('member'), FIXTURE)
    await sleep(200)
    log('a member isn\'t shown the card', (await yourPack(p).count()) === 0)
    await p.evaluate(async FIXTURE => (await import(FIXTURE)).mountStarterCard('admin'), FIXTURE)
    log('an admin is', await until(async () => (await yourPack(p).count()) === 1))
    await p.evaluate(async FIXTURE => (await import(FIXTURE)).mountStarterCard('owner'), FIXTURE)
    log('so is the owner', await until(async () => (await yourPack(p).count()) === 1))

    const mountSheet = role =>
      p.evaluate(
        async ({ FIXTURE, role }) =>
          (await import(FIXTURE)).mountSheet(role, { accountType: 'provider', enforced: true, visitLimit: null, starterPack: 'vic_rental', starterInUse: false, packs: ['core', 'vic_rental'] }),
        { FIXTURE, role },
      )
    const swapButton = () => p.getByRole('dialog').getByRole('button', { name: /^Swap to/ })
    await mountSheet('member')
    await p.getByRole('dialog').waitFor()
    log('a member isn\'t offered the swap on the sheet', (await swapButton().count()) === 0)
    await mountSheet('admin')
    await p.getByRole('dialog').waitFor()
    log('an admin is', (await swapButton().count()) === 1)
    await context.close()
  }

  log('no script errors on any page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}
