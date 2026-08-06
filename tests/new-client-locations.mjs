import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = 'http://localhost:5173/'
const URL = BASE + '#/new-client'

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }) } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const browser = await launch()
const page = await (await testContext(browser, { viewport: { width: 1440, height: 950 } })).newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const save = () => page.getByRole('button', { name: /^save client$/i })
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')
const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))

// name, address, suburb, city, state, postcode
async function fill(vals) {
  const inputs = page.locator('main section input')
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(vals[i])
  await page.waitForTimeout(200)
}
async function fresh() {
  // Navigating to the same hash is a no-op, so route away first to force a
  // fresh mount of the page.
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(200)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(350)
}

const A = ['Equinix', '8 Grand Avenue', 'Rosehill', 'Sydney', 'NSW', '2142']
const B = ['Equinix', '639 Gardeners Road', 'Mascot', 'Sydney', 'NSW', '2020']

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.clear())

  // 1 · brand-new client
  await fresh()
  await fill(A)
  await save().click()
  await page.waitForTimeout(500)
  let s = await store()
  log('new client saved', s.length === 1 && s[0].locations.length === 1,
    `${s.length} client(s), ${s[0]?.locations.length} location(s)`)
  log('no notification for a brand-new client', !/found in the database|already exist/.test(await body()))

  // 2 · same name, different address -> new location under the SAME client
  await fresh()
  await fill(B)
  await save().click()
  await page.waitForTimeout(500)
  const noticeText = await body()
  log('notification: found in the database',
    /Client "Equinix" found in the database\. New location being added\./.test(noticeText))
  s = await store()
  log('ONE client with TWO locations (not two clients)',
    s.length === 1 && s[0].locations.length === 2, `${s.length} client(s), ${s[0]?.locations.length} location(s)`)
  log('continued through to floors/rooms', (await page.getByRole('button', { name: /another floor/i }).count()) === 1)
  await page.screenshot({ path: `${DIR}/loc-added.png` })

  // 3 · exact duplicate -> blocked, nothing written
  await fresh()
  await fill(A)
  await save().click()
  await page.waitForTimeout(500)
  const dupText = await body()
  log('notification: already exist', /Client and location already exist\./.test(dupText))
  const showsAll = ['Name', 'Address', 'Suburb', 'City', 'State', 'Postcode']
    .every(l => dupText.includes(l)) && dupText.includes('8 Grand Avenue') && dupText.includes('Rosehill')
  log('existing location listed beneath the message', showsAll)
  s = await store()
  log('nothing written on duplicate', s.length === 1 && s[0].locations.length === 2,
    `${s.length} client(s), ${s[0]?.locations.length} location(s)`)
  log('Save Client disabled', await save().isDisabled())
  await page.screenshot({ path: `${DIR}/loc-duplicate.png` })

  // 4 · City alone must NOT unblock; Suburb must
  await page.locator('main section input').nth(3).fill('Parramatta')
  await page.waitForTimeout(250)
  log('editing City leaves Save disabled', await save().isDisabled())
  await page.locator('main section input').nth(2).fill('Camellia')
  await page.waitForTimeout(250)
  log('editing Suburb re-enables Save', await save().isEnabled())

  // 5 · matching ignores case and padding
  await fresh()
  await fill(['  eQuiNix  ', '  8   Grand Avenue ', ' ROSEHILL ', 'Sydney', 'NSW', '2142'])
  await save().click()
  await page.waitForTimeout(500)
  log('case/spacing-insensitive match', /Client and location already exist\./.test(await body()))
  s = await store()
  log('still no extra client from the messy input', s.length === 1 && s[0].locations.length === 2,
    `${s.length} client(s), ${s[0]?.locations.length} location(s)`)

  // 6+7 · floors attach to the right location and survive reload
  await fresh()
  await fill(B.map((v, i) => (i === 1 ? '12 Test Street' : v))) // third location
  await save().click()
  await page.waitForTimeout(500)
  await page.locator('main section').filter({ has: page.locator('button', { hasText: 'New Room' }) })
    .first().locator('input').first().fill('Level 9')
  await page.getByRole('button', { name: /another floor/i }).click()
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: /^finished$/i }).click()
  await page.waitForTimeout(600)

  s = await store()
  const locs = s[0].locations
  log('three locations under one client', s.length === 1 && locs.length === 3, `${locs.length}`)
  const third = locs[2], first = locs[0]
  log('empty scaffolding not persisted (loc1 stays empty)', first.floors.length === 0, `loc1=${first.floors.length} floors`)
  log('only the labelled floor saved to the new location', third.floors.length === 1,
    `loc3=${third.floors.length} floor(s)`)
  log('floor label persisted', third.floors[0]?.label === 'Level 9', third.floors[0]?.label)

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const after = await store()
  log('survives a reload', after[0].locations[2].floors[0].label === 'Level 9')

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/loc-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
