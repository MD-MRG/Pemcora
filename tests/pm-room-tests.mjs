import { chromium } from 'playwright-core'

const DIR = process.argv[2] ?? '.'
const BASE = 'http://localhost:5173/'
const URL = BASE + '#/maintenance'

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
        { id: 'r3', name: 'Huddle', planNumber: 'G-03' },
      ]}], visits: [] },
  ]},
]

const browser = await launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
const errs = []
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', e => errs.push(e.message))

const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients') || '[]'))
const entry = async roomId => (await store())[0].locations[0].visits[0]?.rooms?.[roomId] ?? null
const body = async () => (await page.textContent('body')).replace(/\s+/g, ' ')
const rowFor = label => page.locator('div').filter({ hasText: new RegExp(`^${label}PASSFAILN/A$`) }).first()

async function openLocation() {
  await page.goto(BASE + '#/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(120)
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: 'Equinix' }).click()
  await page.waitForTimeout(300)
  await page.locator('tbody tr').filter({ hasText: '8 Grand Avenue' }).click()
  await page.waitForTimeout(350)
}
const openRoom = async name => {
  await page.getByRole('button', { name: new RegExp(name) }).click()
  await page.waitForTimeout(450)
}
const setResult = async (testLabel, value) => {
  await page.getByRole('button', { name: `${testLabel}: ${value}` }).click()
  await page.waitForTimeout(200)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(s => {
    localStorage.setItem('fc.clients', JSON.stringify(s))
    localStorage.removeItem('fc.templates')
  }, SEED)

  await openLocation()
  await page.getByRole('button', { name: /^Start PM$/ }).click()
  await page.waitForTimeout(400)
  await openRoom('Reception')

  // 1 · 19 maintenance tests
  const mainSection = page.locator('main section').first()
  const rows = await mainSection.locator('button[aria-pressed]').count()
  log('main list renders 19 tests', rows === 19 * 3, `${rows / 3} tests`)

  // results persist
  await setResult('Correct Time and Date', 'PASS')
  await setResult('Room Wake On Touch', 'FAIL')
  let e = await entry('r1')
  log('results saved to the store', e?.results?.main && Object.values(e.results.main).includes('PASS') && Object.values(e.results.main).includes('FAIL'))

  // 2 · re-tap clears back to blank, not N/A
  await setResult('Correct Time and Date', 'PASS')
  e = await entry('r1')
  const cleared = Object.values(e.results.main).filter(v => v === 'PASS').length
  log('re-tap clears to blank (not N/A)', cleared === 0 && !Object.values(e.results.main).includes('NA'))
  await setResult('Correct Time and Date', 'PASS')

  // 5 · troubleshooting from FAIL + the discard warning
  let t = await body()
  log('FAIL raises a troubleshooting row', /Troubleshooting/.test(t) && /Room Wake On Touch/.test(t))
  const note = page.locator('textarea').first()
  await note.fill('Panel unresponsive; rebooted')
  await note.blur()
  await page.waitForTimeout(400)

  await setResult('Room Wake On Touch', 'PASS')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Keep the note/ }).click()
  await page.waitForTimeout(300)
  e = await entry('r1')
  const wakeId = Object.keys(e.results.main).find(k => e.results.main[k] === 'FAIL')
  log('cancel keeps the FAIL and the note', !!wakeId && !!e.troubleshooting?.[wakeId])

  await setResult('Room Wake On Touch', 'PASS')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Discard notes/ }).click()
  await page.waitForTimeout(400)
  e = await entry('r1')
  log('confirm clears the FAIL and its note', !Object.values(e.results.main).includes('FAIL') && Object.keys(e.troubleshooting ?? {}).length === 0)

  // 6 · no issues
  log('no FAILs reads "No issues identified."', /No issues identified\./.test(await body()))

  // 3 · section toggle reveals tests
  const rc = page.locator('main section').filter({ hasText: 'Room controls' }).first()
  await rc.locator('input[type=checkbox]').check()
  await page.waitForTimeout(400)
  const rcRows = await rc.locator('button[aria-pressed]').count()
  log('Room controls reveals 9 tests', rcRows === 9 * 3, `${rcRows / 3} tests`)

  await setResult('Ceiling Mic LED Mute Sync', 'FAIL')
  e = await entry('r1')
  log('section FAIL counts while visible', e.fails === 1, `fails=${e.fails}`)

  // 10 · hidden section FAILs excluded but kept
  await rc.locator('input[type=checkbox]').uncheck()
  await page.waitForTimeout(400)
  e = await entry('r1')
  const sectionKey = Object.keys(e.results).find(k => k !== 'main')
  log('hidden section FAIL excluded from count', e.fails === 0, `fails=${e.fails}`)
  log('hidden section results still stored', Object.values(e.results[sectionKey] ?? {}).includes('FAIL'))

  // 7 · comments
  const comments = page.locator('textarea').last()
  await comments.fill('Rack tidy required')
  await comments.blur()
  await page.waitForTimeout(400)
  log('comments saved', (await entry('r1'))?.comments === 'Rack tidy required')

  // 12 · template snapshot
  e = await entry('r1')
  log('room stores its own template snapshot', !!e.template?.tests?.length && e.template.sections.length === 2)

  // 8 · mark complete
  await rc.locator('input[type=checkbox]').check()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Mark room complete/ }).click()
  await page.waitForTimeout(400)
  e = await entry('r1')
  log('room marked complete with fail count', e.status === 'complete' && e.fails === 1, `${e.status} fails=${e.fails}`)

  // 9 · footer navigation
  log('Previous disabled on the first room', await page.getByRole('button', { name: /← Previous/ }).isDisabled())
  await page.getByRole('button', { name: /Next →/ }).click()
  await page.waitForTimeout(450)
  log('Next moves to room 2', /Boardroom/.test(await body()))

  // 4 · carry-forward of section toggles
  const rc2 = page.locator('main section').filter({ hasText: 'Room controls' }).first()
  log('section toggle carried forward to the next room', await rc2.locator('input[type=checkbox]').isChecked())

  await page.getByRole('button', { name: /Next →/ }).click()
  await page.waitForTimeout(450)
  log('Next disabled on the last room', await page.getByRole('button', { name: /Next →/ }).isDisabled())
  await page.screenshot({ path: `${DIR}/pm2-room.png` })

  // back to list, chip reflects completion
  await page.getByRole('button', { name: /^List$/ }).click()
  await page.waitForTimeout(450)
  log('room list chip shows the FAIL count', /1 FAIL/.test(await body()))
  await page.screenshot({ path: `${DIR}/pm2-list.png` })

  // 1b · results survive a reload
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(400)
  await openLocation()
  await openRoom('Reception')
  log('results survive a reload', (await page.getByRole('button', { name: 'Correct Time and Date: PASS' }).getAttribute('aria-pressed')) === 'true')
  await page.getByRole('button', { name: /^List$/ }).click()
  await page.waitForTimeout(400)

  // 11 · finish visit
  await page.getByRole('button', { name: /^Finish visit$/ }).click()
  await page.waitForTimeout(350)
  await page.getByRole('button', { name: /^Finish visit$/ }).last().click()
  await page.waitForTimeout(500)
  const t2 = await body()
  log('Finish visit closes it', /Last visit completed/.test(t2) && (await page.getByRole('button', { name: /^Start new visit$/ }).count()) === 1)
  const visits = (await store())[0].locations[0].visits
  log('visit kept in history with results', visits.length === 1 && !!visits[0].completedAt && !!visits[0].rooms.r1)

  log('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
} catch (e) {
  console.log('ERROR', e.message)
  await page.screenshot({ path: `${DIR}/pm2-error.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
