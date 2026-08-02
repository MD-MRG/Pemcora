import { chromium } from 'playwright-core'

const DIR = process.argv[2] ?? '.'
const BASE = 'http://localhost:5173/'
const URL = BASE + '#/edit-client'

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }) } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const SEED = [
  { id: 'c1', name: 'Equinix', locations: [
    { id: 'l1', address: '8 Grand Avenue', suburb: 'Rosehill', city: 'Sydney', state: 'NSW', postcode: '2142', floors: [] },
    { id: 'l2', address: '639 Gardeners Road', suburb: 'Mascot', city: 'Sydney', state: 'NSW', postcode: '2020', floors: [] },
    { id: 'l3', address: '2 Riverside Quay', suburb: 'Southbank', city: 'Melbourne', state: 'VIC', postcode: '3006', floors: [] },
  ]},
  { id: 'c2', name: 'Acme Industrial', locations: [
    { id: 'l4', address: '1 Smith Street', suburb: 'Parramatta', city: 'Sydney', state: 'NSW', postcode: '2150', floors: [] },
  ]},
  { id: 'c3', name: 'Zenith Health', locations: [
    { id: 'l5', address: '99 Collins Street', suburb: 'Docklands', city: 'Melbourne', state: 'VIC', postcode: '3008', floors: [] },
  ]},
]

const browser = await launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
const saveBtn = () => page.getByRole('button', { name: /^save changes$/i })
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')
const detailInputs = () => page.locator('main section input')

async function reopen() {
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(150)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(350)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(s => localStorage.setItem('fc.clients', JSON.stringify(s)), SEED)
  await reopen()

  // 1 · alphabetical, 3 columns
  const names = await page.locator('tbody tr td:nth-child(1)').allTextContents()
  const clean = names.map(n => n.replace(/\d+ locations/, '').trim())
  log('clients listed alphabetically', clean.join('|') === 'Acme Industrial|Equinix|Zenith Health', clean.join(' | '))

  // 2 · multi-location row summarised
  const eq = page.locator('tbody tr').filter({ hasText: 'Equinix' })
  log('multi-location client shows ONE row', (await eq.count()) === 1, String(await eq.count()))
  const eqText = (await eq.textContent()).replace(/\s+/g, ' ')
  log('badge + joined distinct State/City', /3 locations/.test(eqText) && /NSW, VIC/.test(eqText) && /Sydney, Melbourne/.test(eqText), eqText.trim())
  await page.screenshot({ path: `${DIR}/ec-clients.png` })

  // 3 · name search
  await page.getByPlaceholder('Client name').fill('zen')
  await page.waitForTimeout(250)
  log('name search narrows', (await page.locator('tbody tr').count()) === 1)
  await page.getByPlaceholder('Client name').fill('')
  await page.waitForTimeout(250)
  log('clearing search restores', (await page.locator('tbody tr').count()) === 3)

  // 4 · filter field -> value
  await page.locator('select').first().selectOption('state')
  await page.waitForTimeout(250)
  await page.getByLabel('Filter by state').selectOption('VIC')
  await page.waitForTimeout(300)
  const vicRows = await page.locator('tbody tr td:nth-child(1)').allTextContents()
  const vicClean = vicRows.map(n => n.replace(/\d+ locations/, '').trim()).sort()
  log('filter by VIC keeps clients with ANY VIC location', vicClean.join('|') === 'Equinix|Zenith Health', vicClean.join(' | '))
  await page.getByLabel('Filter by state').selectOption('')
  await page.locator('select').first().selectOption('all')
  await page.waitForTimeout(250)

  // 5 · level 2
  await eq.click()
  await page.waitForTimeout(400)
  log('level 2 lists one row per location', (await page.locator('tbody tr').count()) === 3, String(await page.locator('tbody tr').count()))
  const heads = await page.locator('thead th').allTextContents()
  log('five location columns', heads.join('|') === 'State|City|Street address|Suburb|Postcode', heads.join(' | '))
  await page.screenshot({ path: `${DIR}/ec-locations.png` })

  // 6 · level 3
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(400)
  log('level 3 header names the client', /Edit Equinix/.test(await body()))
  const vals = await detailInputs().evaluateAll(els => els.slice(0, 6).map(e => e.value))
  log('six fields populated', vals.join('|') === 'Equinix|8 Grand Avenue|Rosehill|Sydney|NSW|2142', vals.join(' | '))

  // 7 · dirty gating
  log('Save Changes starts disabled', await saveBtn().isDisabled())
  await detailInputs().nth(4).fill('NSW ')
  await page.waitForTimeout(200)
  log('trimmed-equal edit stays disabled', await saveBtn().isDisabled())
  await detailInputs().nth(5).fill('2145')
  await page.waitForTimeout(200)
  log('real edit enables Save', await saveBtn().isEnabled())
  await detailInputs().nth(5).fill('')
  await page.waitForTimeout(200)
  log('clearing a mandatory field disables Save', await saveBtn().isDisabled())
  await detailInputs().nth(5).fill('2142')
  await page.waitForTimeout(200)

  // 8 · THE TRAP: save without touching the address must not self-block
  await detailInputs().nth(3).fill('Sydney CBD')
  await page.waitForTimeout(200)
  await saveBtn().click()
  await page.waitForTimeout(400)
  const afterSelf = await body()
  log('self-match does NOT block the save', /Changes added\./.test(afterSelf) && !/already exist/.test(afterSelf))
  let s = await store()
  log('edit written to the right location', s[0].locations[0].city === 'Sydney CBD', s[0].locations[0].city)

  // 9 · sibling duplicate
  await detailInputs().nth(1).fill('639 Gardeners Road')
  await detailInputs().nth(2).fill('Mascot')
  await page.waitForTimeout(250)
  await saveBtn().click()
  await page.waitForTimeout(400)
  const dupText = await body()
  log('sibling duplicate blocked', /Client and location already exist\./.test(dupText))
  log('existing location listed', dupText.includes('639 Gardeners Road') && dupText.includes('Mascot'))
  s = await store()
  log('store unchanged by duplicate', s[0].locations[0].address === '8 Grand Avenue', s[0].locations[0].address)
  log('Save disabled after duplicate', await saveBtn().isDisabled())
  await detailInputs().nth(2).fill('Camellia')
  await page.waitForTimeout(250)
  log('changing Suburb re-enables Save', await saveBtn().isEnabled())
  await page.screenshot({ path: `${DIR}/ec-duplicate.png` })

  // 10 · rename
  await detailInputs().nth(1).fill('8 Grand Avenue')
  await detailInputs().nth(2).fill('Rosehill')
  await detailInputs().nth(0).fill('Equinix Australia')
  await page.waitForTimeout(250)
  await saveBtn().click()
  await page.waitForTimeout(400)
  s = await store()
  log('rename applies to the whole client', s.find(c => c.id === 'c1')?.name === 'Equinix Australia' && s.find(c => c.id === 'c1')?.locations.length === 3)

  await detailInputs().nth(0).fill('Acme Industrial')
  await page.waitForTimeout(250)
  await saveBtn().click()
  await page.waitForTimeout(400)
  log('rename onto another client is blocked', /already exists/.test(await body()))
  s = await store()
  log('store unchanged by name conflict', s.find(c => c.id === 'c1')?.name === 'Equinix Australia')

  // 11 · add location
  await detailInputs().nth(0).fill('Equinix Australia')
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: /add location/i }).click()
  await page.waitForTimeout(400)
  log('Add location opens a blank form', (await detailInputs().nth(1).inputValue()) === '')
  await detailInputs().nth(1).fill('7 Test Parade')
  await detailInputs().nth(2).fill('Newtown')
  await detailInputs().nth(3).fill('Sydney')
  await detailInputs().nth(4).fill('NSW')
  await detailInputs().nth(5).fill('2042')
  await page.waitForTimeout(250)
  await saveBtn().click()
  await page.waitForTimeout(500)
  s = await store()
  log('client gains a 4th location', s.find(c => c.id === 'c1')?.locations.length === 4, String(s.find(c => c.id === 'c1')?.locations.length))
  log('floors editor appears once saved', (await page.getByRole('button', { name: /another floor/i }).count()) === 1)

  // 12 · floors autosave + reload
  await page.locator('main section').filter({ has: page.locator('button', { hasText: 'New Room' }) })
    .first().locator('input').first().fill('Level 3')
  await page.waitForTimeout(1000)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  s = await store()
  const added = s.find(c => c.id === 'c1').locations[3]
  log('floors autosaved and survive reload', added.floors[0]?.label === 'Level 3', added.floors[0]?.label)
  await page.screenshot({ path: `${DIR}/ec-edit.png` })

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/ec-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
