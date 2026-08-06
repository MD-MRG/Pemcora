import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = (process.env.PEMCORA_BASE ?? 'http://localhost:5173/')

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }) } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const SEED = [
  { id: 'c1', name: 'Equinix', locations: [
    { id: 'l1', address: '8 Grand Avenue', suburb: 'Rosehill', city: 'Sydney', state: 'NSW', postcode: '2142',
      floors: [{ id: 'f1', label: 'Ground', rooms: [
        { id: 'r1', name: 'Reception', planNumber: 'G-01' },
        { id: 'r2', name: 'Boardroom', planNumber: 'G-02' },
      ]}], visits: [] },
  ]},
]

const browser = await launch()
const page = await (await testContext(browser, { viewport: { width: 1440, height: 1000 } })).newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const templates = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.templates') || '{}'))
const clients = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')

async function goto(route) {
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(120)
  await page.goto(BASE + route, { waitUntil: 'networkidle' })
  await page.waitForTimeout(350)
}
const tab = name => page.getByRole('button', { name, exact: true })
const mainTests = () => page.locator('input[aria-label^="Main test"]')

async function openRoom(route, roomName) {
  await goto(route)
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(400)
  const start = page.getByRole('button', { name: /^Start (PM|commissioning)$/ })
  if (await start.count()) {
    await start.click()
    await page.waitForTimeout(450)
  }
  await page.getByRole('button', { name: new RegExp(roomName) }).click()
  await page.waitForTimeout(500)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(s => {
    localStorage.clear()
    localStorage.setItem('fc.clients', JSON.stringify(s))
  }, SEED)

  // 1 · three templates, each with its own contents
  await goto('#/settings')
  log('maintenance list loads with 19 tests', (await mainTests().count()) === 19, `${await mainTests().count()}`)
  await tab('Commissioning').click()
  await page.waitForTimeout(350)
  log('commissioning list loads with 25 tests', (await mainTests().count()) === 25, `${await mainTests().count()}`)
  await tab('Custom List').click()
  await page.waitForTimeout(350)
  log('custom list starts empty', (await mainTests().count()) === 0 && /No tests yet/.test(await body()))
  await page.screenshot({ path: `${DIR}/template-editor.png` })

  // 2 · custom list: build it from nothing, with a named section
  await page.getByRole('button', { name: '+ Add test' }).first().click()
  await page.waitForTimeout(250)
  await mainTests().first().fill('Verify rack earthing')
  await page.getByLabel('Main list heading').fill('Site checks')
  await page.getByRole('button', { name: '+ Add section' }).click()
  await page.waitForTimeout(300)
  await page.getByLabel('Section 1 name').fill('Loading dock')
  await page.waitForTimeout(400)
  let t = await templates()
  log('custom heading renamed', t.custom.mainLabel === 'Site checks', t.custom.mainLabel)
  log('custom test added', t.custom.tests[0]?.label === 'Verify rack earthing')
  log('named section added', t.custom.sections[0]?.label === 'Loading dock')

  // 3 · maintenance edits: rename, add, reorder, remove
  await tab('Preventative Maintenance').click()
  await page.waitForTimeout(350)
  await mainTests().first().fill('Correct date and time')
  await page.waitForTimeout(300)
  t = await templates()
  log('rename saved', t.maintenance.tests[0].label === 'Correct date and time')

  await page.getByRole('button', { name: 'Move Room Wake On Touch down' }).click()
  await page.waitForTimeout(300)
  t = await templates()
  log('reorder moves the test down', t.maintenance.tests[2].label === 'Room Wake On Touch',
    t.maintenance.tests.slice(0, 3).map(x => x.label).join(' | '))
  log('order values reindexed', t.maintenance.tests.every((x, i) => x.order === i))

  await page.getByRole('button', { name: 'Remove BYOD' }).click()
  await page.waitForTimeout(300)
  t = await templates()
  log('remove drops the test', t.maintenance.tests.length === 18 && !t.maintenance.tests.some(x => x.label === 'BYOD'))

  // 4 · templates stay independent
  log('commissioning untouched by maintenance edits',
    (await templates()).commissioning.tests.length === 25 &&
    (await templates()).commissioning.tests[0].label === 'Correct Time and Date')

  // 5 · a NEW room picks the edits up
  await openRoom('#/maintenance', 'Reception')
  t = await body()
  log('new room uses the renamed test', /Correct date and time/.test(t))
  log('new room reflects the removal', !/BYOD/.test(t))
  const rows = await page.locator('main section').first().locator('button[aria-pressed]').count()
  log('new room has 18 tests', rows === 18 * 3, `${rows / 3}`)

  // mark it complete so it becomes "already filled in"
  await page.getByRole('button', { name: 'Correct date and time: PASS' }).click()
  await page.waitForTimeout(250)
  await page.getByRole('button', { name: /Mark room complete/ }).click()
  await page.waitForTimeout(400)

  // 6 · THE RULE: editing the list must not rewrite completed work
  await goto('#/settings')
  await mainTests().first().fill('EDITED AFTER COMPLETION')
  await page.getByRole('button', { name: '+ Add test' }).first().click()
  await page.waitForTimeout(400)
  const after = await templates()
  log('template now says EDITED AFTER COMPLETION', after.maintenance.tests[0].label === 'EDITED AFTER COMPLETION')

  await goto('#/maintenance')
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Reception/ }).click()
  await page.waitForTimeout(500)
  t = await body()
  log('completed room keeps its own snapshot', /Correct date and time/.test(t) && !/EDITED AFTER COMPLETION/.test(t))
  const snap = (await clients())[0].locations[0].visits[0].rooms.r1.template
  log('snapshot stored on the room, not read live', snap.tests[0].label === 'Correct date and time')

  // a room opened for the FIRST time now gets the newer list
  await page.getByRole('button', { name: /^List$/ }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Boardroom/ }).click()
  await page.waitForTimeout(500)
  log('a freshly opened room gets the current list', /EDITED AFTER COMPLETION/.test(await body()))

  // 7 · reset to defaults
  await goto('#/settings')
  await page.getByRole('button', { name: /Reset to defaults/ }).click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^Reset$/ }).click()
  await page.waitForTimeout(500)
  t = await templates()
  log('reset restores the 19 defaults',
    t.maintenance.tests.length === 19 && t.maintenance.tests[0].label === 'Correct Time and Date',
    `${t.maintenance.tests.length} tests`)
  log('reset left the custom list alone', t.custom.mainLabel === 'Site checks')

  // 8 · removing a section confirms first
  await tab('Custom List').click()
  await page.waitForTimeout(350)
  await page.getByRole('button', { name: /^Remove$/ }).first().click()
  await page.waitForTimeout(300)
  log('section removal asks first', /Remove "Loading dock"/.test(await body()))
  await page.getByRole('button', { name: /Remove section/ }).click()
  await page.waitForTimeout(400)
  log('section removed after confirming', (await templates()).custom.sections.length === 0)

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/template-editor-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
