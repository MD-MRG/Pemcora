/**
 * Teams page — what a suite can actually reach.
 *
 * The suites run with no session, which is where this page's honesty matters
 * most: teams, roles and invitations are all server-side, so with nothing but
 * localStorage behind it the page has to say so rather than render an empty
 * roster that looks like a team with nobody in it.
 *
 * Everything past that point — creating a team, the invite box, the roster and
 * its owner-only controls — needs a real session and is not on this path. It
 * was driven by hand against the live project instead; see the pull request.
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
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
const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForTimeout(400)

  // 1 · it is in the sidebar, under Custom List and above the divider
  const labels = await page.locator('nav[aria-label="Main"] a').allTextContents()
  log('Teams is in the main nav', labels.includes('Teams'), labels.join(' | '))
  log(
    'Teams sits directly under Custom List',
    labels.indexOf('Teams') === labels.indexOf('Custom List') + 1,
    `${labels.indexOf('Custom List')} -> ${labels.indexOf('Teams')}`,
  )

  // 2 · it routes and retitles
  await page.locator('nav a', { hasText: /^Teams$/ }).first().click()
  await page.waitForTimeout(300)
  log('clicking it routes to #/teams', page.url().includes('#/teams'), page.url())
  const h1 = (await page.locator('h1').first().textContent()).trim()
  log('page heading is Teams', h1 === 'Teams', h1)

  // 3 · with no session it explains itself rather than showing an empty team
  const body = await page.locator('main').innerText()
  log('says teams need an account', /Teams need an account/i.test(body))
  log('does not claim to have a roster', !/Accounts/.test(body), body.slice(0, 120))
  log(
    'no create-team form without a session',
    (await page.getByRole('button', { name: /create team/i }).count()) === 0,
  )

  // 4 · a deep link to it survives a reload like every other route
  await page.goto(BASE + '#/teams', { waitUntil: 'networkidle' })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  const deepH1 = (await page.locator('h1').first().textContent()).trim()
  log('deep link survives a hard reload', deepH1 === 'Teams', deepH1)

  await page.screenshot({ path: `${DIR}/teams-local.png` })
} catch (e) {
  log('suite ran to completion', false, e.message)
  await page.screenshot({ path: `${DIR}/teams-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
