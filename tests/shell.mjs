import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const URL = (process.env.PEMCORA_BASE ?? 'http://localhost:5173/')

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }) } catch {}
  }
  return await chromium.launch({ headless: true })
}
const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const browser = await launch()
const ctx = await testContext(browser, { viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const navW = () => page.evaluate(() => {
  const g = document.querySelector('.shell-grid')
  if (!g) return null
  return Math.round(parseFloat(getComputedStyle(g).gridTemplateColumns.split(' ')[0]))
})

try {
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)

  // 1 · shell + all seven items
  const items = await page.locator('nav[aria-label="Main"] a').allTextContents()
  log('all seven nav items present', items.length === 7, `${items.length}: ${items.join(' | ')}`)
  const activeText = await page.locator('nav a[aria-current="page"]').textContent()
  log('Home active on first load', activeText.trim() === 'Home', activeText.trim())

  // 2 · navigation drives hash + title + aria-current
  const routes = [
    ['New Client', '#/new-client'],
    ['Edit Client', '#/edit-client'],
    ['Commissioning', '#/commissioning'],
    ['Preventative Maintenance', '#/maintenance'],
    ['Custom List', '#/custom-list'],
    ['Settings', '#/settings'],
  ]
  let navOk = true, detail = ''
  for (const [label, hash] of routes) {
    await page.locator('nav a', { hasText: new RegExp(`^${label}$`) }).first().click()
    await page.waitForTimeout(220)
    const url = page.url()
    const h1 = (await page.locator('h1').first().textContent()).trim()
    const cur = (await page.locator('nav a[aria-current="page"]').textContent()).trim()
    const ok = url.includes(hash) && h1 === label && cur === label
    if (!ok) { navOk = false; detail += `${label}(url:${url.split('#')[1]} h1:${h1} cur:${cur}) ` }
  }
  log('every nav item routes + retitles + sets aria-current', navOk, detail)

  // 3 · deep link survives a hard reload (v2 could not)
  await page.goto(URL + '#/commissioning', { waitUntil: 'networkidle' })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const deepH1 = (await page.locator('h1').first().textContent()).trim()
  log('deep link survives hard reload', deepH1 === 'Commissioning', deepH1)

  // 4 · collapse toggle
  const wideBefore = await navW()
  await page.getByRole('button', { name: /collapse navigation/i }).click()
  await page.waitForTimeout(450)
  const railW = await navW()
  const labelsHidden = await page.locator('nav a span.truncate').count()
  const ariaLabels = await page.locator('nav a[aria-label]').count()
  log('toggle collapses to rail', wideBefore === 264 && railW === 68, `${wideBefore} -> ${railW}`)
  log('labels hidden in rail mode', labelsHidden === 0, `${labelsHidden} visible label spans`)
  log('every rail item keeps an aria-label', ariaLabels === 7, `${ariaLabels}/7`)
  await page.screenshot({ path: `${DIR}/fc-rail.png` })

  // 5 · preference persists
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  log('collapse preference persists across reload', (await navW()) === 68, String(await navW()))
  await page.getByRole('button', { name: /expand navigation/i }).click()
  await page.waitForTimeout(450)
  log('toggle back to expanded', (await navW()) === 264, String(await navW()))
  await page.screenshot({ path: `${DIR}/fc-1440.png` })

  // 6 · responsive
  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(500)
  log('auto-rails at tablet width', (await navW()) === 68, String(await navW()))
  await page.screenshot({ path: `${DIR}/fc-900.png` })

  await page.setViewportSize({ width: 600, height: 850 })
  await page.waitForTimeout(500)
  const gridGone = (await page.locator('.shell-grid').count()) === 0
  const burger = page.getByRole('button', { name: /open navigation/i })
  log('phone drops the grid for a drawer layout', gridGone && (await burger.count()) === 1)
  await burger.click()
  await page.waitForTimeout(400)
  const drawerOpen = await page.locator('[role="dialog"][aria-label="Navigation"]').isVisible()
  log('drawer opens', drawerOpen)
  await page.screenshot({ path: `${DIR}/fc-600-drawer.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  log('drawer closes on Escape', (await page.locator('[role="dialog"]').count()) === 0)
  await page.screenshot({ path: `${DIR}/fc-600.png` })

  // 7 · brand plate colour
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(URL + '#/settings', { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const plateBg = () => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--plate-bg').trim())
  const before = await plateBg()
  await page.locator('button[aria-pressed]').filter({ hasText: 'Espresso' }).click()
  await page.waitForTimeout(400)
  const after = await plateBg()
  log('brand plate colour changes', before !== after, `${before} -> ${after}`)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  log('brand plate persists across reload', (await plateBg()) === after, await plateBg())
  await page.screenshot({ path: `${DIR}/fc-settings.png` })

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/fc-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
