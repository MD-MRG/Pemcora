import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const URL = (process.env.PEMCORA_BASE ?? 'http://localhost:5173/') + '#/new-client'

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
const headerText = () => page.locator('main header p').last().textContent()
const floorSections = () => page.locator('main section').filter({ has: page.locator('button', { hasText: 'New Room' }) })

try {
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)

  // 1 · all four required, checked one at a time
  const inputs = page.locator('main input')
  log('six detail fields render', (await inputs.count()) === 6, String(await inputs.count()))
  log('Save disabled when empty', await save().isDisabled())

  const vals = ['Equinix', '8 Grand Avenue', 'Rosehill', 'Sydney', 'NSW', '2142']
  let stayedDisabled = true
  for (let i = 0; i < 5; i++) {
    await inputs.nth(i).fill(vals[i])
    await page.waitForTimeout(120)
    if (!(await save().isDisabled())) stayedDisabled = false
  }
  log('Save stays disabled through 5 of 6 filled', stayedDisabled)
  await inputs.nth(5).fill(vals[5])
  await page.waitForTimeout(180)
  log('Save enables once all six filled', await save().isEnabled())
  await page.screenshot({ path: `${DIR}/nc-phase1.png` })

  // 2 · save collapses details into a header
  await save().click()
  await page.waitForTimeout(400)
  log('detail inputs replaced by header', (await page.getByRole('button', { name: /^save client$/i }).count()) === 0)
  const h2 = (await page.locator('main h2').first().textContent()).trim()
  log('header shows client name', h2 === 'Equinix', h2)

  // 3 · initial counts
  log('counts start at 1 floor / 1 room', /1 floor · 1 room/.test(await headerText()), (await headerText()).trim())

  // 4 · New Room appends within its floor
  await floorSections().first().getByRole('button', { name: /new room/i }).click()
  await page.waitForTimeout(300)
  log('New Room -> 1 floor / 2 rooms', /1 floor · 2 rooms/.test(await headerText()), (await headerText()).trim())
  log('focus moved to the new room input',
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || ''),
  )

  // 5 · Another floor
  await page.getByRole('button', { name: /another floor/i }).click()
  await page.waitForTimeout(300)
  log('Another floor -> 2 floors / 3 rooms', /2 floors · 3 rooms/.test(await headerText()), (await headerText()).trim())
  log('two floor blocks now render', (await floorSections().count()) === 2, String(await floorSections().count()))

  // 6 · the ordering bug: a room added on floor 2 must not land on floor 1
  await floorSections().nth(1).getByRole('button', { name: /new room/i }).click()
  await page.waitForTimeout(300)
  const f1Rooms = await floorSections().nth(0).locator('input[aria-label*="room"][aria-label*="name"]').count()
  const f2Rooms = await floorSections().nth(1).locator('input[aria-label*="room"][aria-label*="name"]').count()
  log('room lands on floor 2, not floor 1', f1Rooms === 2 && f2Rooms === 2, `floor1=${f1Rooms} floor2=${f2Rooms}`)
  log('counts -> 2 floors / 4 rooms', /2 floors · 4 rooms/.test(await headerText()), (await headerText()).trim())

  // 7 · names remain editable after creation
  const floor2Label = floorSections().nth(1).locator('input').first()
  await floor2Label.fill('Ground')
  const room = floorSections().nth(0).locator('input[aria-label*="room 1 name"]')
  await room.fill('Main Conference Room')
  await page.waitForTimeout(200)
  log('floor + room names editable after creation',
    (await floor2Label.inputValue()) === 'Ground' && (await room.inputValue()) === 'Main Conference Room')

  // 8 · no delete controls anywhere
  const del = await page.getByRole('button', { name: /delete|remove|✕|×/i }).count()
  log('no delete/remove controls', del === 0, `${del} found`)

  // 9 · new-floor focus
  await page.getByRole('button', { name: /another floor/i }).click()
  await page.waitForTimeout(350)
  const focusPh = await page.evaluate(() => document.activeElement?.getAttribute('placeholder') || '')
  log('focus moves to the new floor input', /Level 47/.test(focusPh), focusPh)
  await page.screenshot({ path: `${DIR}/nc-phase2.png` })

  // 10 · Finished returns Home
  await page.getByRole('button', { name: /^finished$/i }).click()
  await page.waitForTimeout(450)
  log('Finished navigates Home', page.url().endsWith('#/'), page.url().split('#')[1])

  // narrow layout
  await page.setViewportSize({ width: 600, height: 900 })
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${DIR}/nc-600.png` })

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/nc-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
