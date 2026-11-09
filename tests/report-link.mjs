/**
 * Step D3a: the report link page, `#/r/<token>`.
 *
 * The link's helpers in Node, then the page in a browser in test mode, with
 * report_preview() answered here as the database would answer it. Nothing can
 * reach the live project.
 *
 *   node tests/report-link.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the page to:
 *   - it opens for whoever holds the link, in front of the sign-in gate
 *   - a malformed link asks the database nothing; an unknown one says it isn't valid
 *   - a working link shows who sent it, what, where, when, the outcome, the
 *     sign-off and each issue with its note
 *   - an expired link names who to ask, and shows nothing of the report
 *   - a saved report asks them to sign in, and shows nothing of it
 *   - with no connection it says so, and tries again
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'
const localhost = new URL(BASE).hostname

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

// ── The helpers ──────────────────────────────────────────────────────────────
const L = await import('../src/lib/reportLink.js')
const TOKEN = '6f1c2a9e-4b7d-4e2f-9a31-0c5d8e7f6a21'
log('a report link is told from the app\'s own pages', L.isReportLink(`#/r/${TOKEN}`) && L.isReportLink('#/r') && !L.isReportLink('#/reports') && !L.isReportLink('#/'))
log('its token is read', L.reportTokenFrom(`#/r/${TOKEN}`) === TOKEN && L.reportTokenFrom(`#/r/${TOKEN.toUpperCase()}/`) === TOKEN)
log('…and anything that isn\'t one is not', [`#/r/`, '#/r/abc', `#/r/${TOKEN}/x`, `#/r/${TOKEN}?a=1`, '#/r/%E0%A4%A', null].every(h => L.reportTokenFrom(h) === null))
log('the site reads as one line', L.siteLine({ address: '10 Smith St', suburb: 'Toowong', state: 'QLD', postcode: '4066' }) === '10 Smith St, Toowong QLD 4066')
log('the date is written out, as the date it is', L.longDate('2026-11-06') === '6 November 2026' && L.longDate('') === '')

const SNAPSHOT = {
  reportTitle: 'Smoke Alarm Compliance Inspection',
  revision: 2,
  client: 'Rental Co',
  technician: 'Sam Sparks',
  provider: { name: 'Sparky team', company: { name: 'Sparky Co', licence_number: 'L-1', rec_number: 'REC-9', phone: '0400 000 000', email: 'office@sparky.test' } },
  signoff: { technician: 'Sam Sparks', licence_number: 'QLD-77', signed_at: '2026-11-06T03:00:00Z' },
  site: { failed: [{ label: 'Interconnected', item: 'Hall alarm', note: 'Replace within 7 days', mustReplace: true }] },
  rooms: [{ name: 'Bedroom 1', failed: [{ label: 'Sounds when tested', note: 'Battery flat' }] }, { name: 'Kitchen', failed: [] }],
}
const PREVIEW = {
  status: 'ok', workflow: 'Smoke alarm compliance inspection', provider: 'Sparky team', completed_on: '2026-11-06', outcome: 'non_compliant',
  site: { address: '10 Smith St', suburb: 'Toowong', state: 'QLD', postcode: '4066' }, snapshot: SNAPSHOT, has_file: true, claimed: false,
}
const sum = L.reportSummary({ ...PREVIEW, completedOn: PREVIEW.completed_on, hasFile: true })
log('the summary names the business as the database wrote it, with its numbers', sum.business === 'Sparky Co' && sum.contact.join(' · ') === 'Licence L-1 · REC REC-9 · 0400 000 000 · office@sparky.test')
log('…what, where, when and how it went', sum.check === 'Smoke Alarm Compliance Inspection' && sum.site === '10 Smith St, Toowong QLD 4066' && sum.completedOn === '6 November 2026' && sum.outcome === 'Non-compliant' && sum.revision === 2)
log('…who signed it off', sum.signedBy === 'Sam Sparks, licence QLD-77')
log('…and each issue, where it is', JSON.stringify(sum.issues) === JSON.stringify([
  { where: 'Hall alarm', label: 'Interconnected', note: 'Replace within 7 days', mustReplace: true },
  { where: 'Bedroom 1', label: 'Sounds when tested', note: 'Battery flat', mustReplace: false },
]))
log('a report with nothing in it still reads', L.reportSummary({ status: 'ok', provider: 'X' }).business === 'X' && L.reportSummary({}).issues.length === 0)

// ── The page ─────────────────────────────────────────────────────────────────
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const server = { answer: [PREVIEW], down: false, asked: [] }
async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  server.asked.push({ path: url.pathname, body: req.postData() })
  if (server.down) return route.abort('internetdisconnected')
  if (url.pathname === '/rest/v1/rpc/report_preview') {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(server.answer) })
  }
  return route.abort()
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  await ctx.route('**/*', backend)
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
  const body = () => page.textContent('body')
  const open = async hash => {
    await page.goto(BASE + hash, { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
  }

  if (!configured) {
    console.log('(the page checks need VITE_SUPABASE_URL in .env, and were skipped; nothing is sent there)')
  } else {
    // A malformed link.
    server.asked = []
    await open('#/r/not-a-token')
    log('a malformed link says it isn\'t valid', await until(async () => /This report link isn't valid/.test(await body())))
    log('…without asking the database', server.asked.length === 0)

    // A working link.
    server.asked = []
    await open(`#/r/${TOKEN.toUpperCase()}`)
    log('a working link opens the report, in front of the sign-in gate', await until(async () => /Smoke Alarm Compliance Inspection/.test(await body())))
    log('…asking the database about that token', JSON.parse(server.asked.at(-1)?.body ?? '{}').p_token === TOKEN)
    const text = await body()
    log('it says who sent it, with their numbers', /A report sent to you from Sparky Co\./.test(text) && /Licence L-1 · REC REC-9 · 0400 000 000 · office@sparky\.test/.test(text))
    log('…where, for whom, when and how it went', ['10 Smith St, Toowong QLD 4066', 'Rental Co', '6 November 2026', 'Non-compliant'].every(s => text.includes(s)))
    log('…who signed it off, and that it\'s a revision', text.includes('Sam Sparks, licence QLD-77') && text.includes('Revision 2, replacing the one before'))
    log('…and each issue with its note', /Issues found \(2\)/.test(text) && /Hall alarm: Interconnected · must be replaced/.test(text) && text.includes('Replace within 7 days')
      && /Bedroom 1: Sounds when tested/.test(text) && text.includes('Battery flat'))
    await page.screenshot({ path: `${DIR}/report-link.png`, fullPage: true })

    // Reached from inside the app, without a reload.
    await page.evaluate(() => {
      window.location.hash = '#/'
    })
    log('moving off the link inside the app shows the app again', await until(async () => !/Smoke Alarm Compliance Inspection/.test(await body())))
    await page.evaluate(t => {
      window.location.hash = `#/r/${t}`
    }, TOKEN)
    log('a link followed inside the app opens it too', await until(async () => /A report sent to you from Sparky Co/.test(await body())))
    await page.getByRole('button', { name: 'Go to Pemcora' }).click()
    log('"Go to Pemcora" leaves it', await until(async () => !/A report sent to you/.test(await body())) && (await page.evaluate(() => window.location.hash)) === '#/')

    // Nothing behind it.
    server.answer = []
    await open(`#/r/${TOKEN}`)
    log('a link that leads nowhere says it isn\'t valid', await until(async () => /This report link isn't valid/.test(await body())))

    // Expired: the provider's name, and nothing of the report.
    server.answer = [{ status: 'expired', workflow: null, provider: 'Sparky team', completed_on: null, outcome: null, site: null, snapshot: null, has_file: null, claimed: false }]
    await open(`#/r/${TOKEN}`)
    log('an expired link says so, and who to ask', await until(async () => /This link has expired/.test(await body())) && /Ask Sparky team to send it again/.test(await body()))
    log('…showing nothing of the report', !/Issues found|Toowong/.test(await body()))

    // Saved: sign in.
    server.answer = [{ ...server.answer[0], status: 'saved', claimed: true }]
    await open(`#/r/${TOKEN}`)
    log('a saved report asks them to sign in', await until(async () => /This report has been saved to a Pemcora account/.test(await body())) && (await page.getByRole('button', { name: 'Sign in' }).count()) === 1)
    log('…showing nothing of it either', !/Issues found|Toowong/.test(await body()))

    // No connection.
    server.answer = [PREVIEW]
    server.down = true
    await open(`#/r/${TOKEN}`)
    log('with no connection it says so', await until(async () => /The report couldn't be opened/.test(await body())) && /needs a connection/.test(await body()), (await body()).slice(0, 200))
    server.down = false
    await page.getByRole('button', { name: 'Try again' }).click()
    log('…and "Try again" opens it once there is one', await until(async () => /A report sent to you from Sparky Co/.test(await body())))
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
