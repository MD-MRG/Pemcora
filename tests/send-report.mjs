/**
 * Step D2c: "Send report" on a finished visit, "Send again" and "Withdraw".
 *
 * In a browser in test mode. Every request off this machine is answered here, as
 * the report bucket, the deliver-report function and the database would answer
 * it, or refused: nothing can reach the live project or send an email.
 *
 *   node tests/send-report.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - only a finished visit, on a signed-in team, offers it, with the client's
 *     contact email filled in; no connection or no address, no send
 *   - the PDF goes to the team's report folder first, then the function gets
 *     its path, the visit, the snapshot and the address
 *   - a send counts as a revision, asked the same way Export PDF asks
 *   - a refusal (the daily cap) is shown as the database put it, and records no
 *     revision
 *   - with no mailer, or no function deployed yet, the link is handed over and
 *     never called emailed
 *   - the sent list: "Send again" to the same delivery, "Withdraw" until saved
 *   - a note still saying [timeframe] is found in the snapshot before anything goes
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'
const localhost = new URL(BASE).hostname

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const TEAM = '22222222-2222-4222-8222-222222222222'
const ENTITLEMENTS = {
  enforced: false, accountType: 'provider', plan: 'free', isPro: false, seatLimit: 1, seatsUsed: 1,
  visitLimit: 1, visitsUsed: 0, packs: ['core', 'qld_electrical'], pastDueUntil: null,
  cancelAt: null, importUsed: false, openVisits: 0, starterPack: 'qld_electrical', starterInUse: true,
}

// ── The stand-in bucket, function and database ──────────────────────────────
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const reply = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
const server = { mode: 'emailed', asked: [], uploads: [], calls: [], rpcs: [], deliveries: [], seq: 0 }
const EXPIRES = '2027-02-04T03:00:00+00:00'

async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const path = decodeURIComponent(url.pathname)
  server.asked.push(`${req.method()} ${path}`)

  if (path === '/rest/v1/attachments') return reply(route, 200, [])
  if (path.startsWith('/storage/v1/object/reports/') && req.method() === 'POST') {
    const name = path.slice('/storage/v1/object/reports/'.length)
    server.uploads.push({ name, type: req.headers()['content-type'], body: req.postDataBuffer() })
    return reply(route, 200, { Key: `reports/${name}` })
  }
  if (path === '/functions/v1/deliver-report' && req.method() === 'POST') {
    const body = JSON.parse(req.postData())
    server.calls.push(body)
    if (server.mode === 'missing') return reply(route, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' })
    if (server.mode === 'cap') {
      return reply(route, 429, { error: 'Your team has sent its 10 reports for the last 24 hours. Try again later.', code: 'PT429', hint: 'send_cap' })
    }
    const id = body.action === 'resend' ? body.deliveryId : `d${++server.seq}`
    const email = body.action === 'resend' ? server.deliveries.find(d => d.id === id)?.recipient_email : body.email
    if (body.action === 'send') {
      server.deliveries.unshift({ id, recipient_email: email, sent_at: new Date().toISOString(), link_expires_at: EXPIRES, opened_at: null, claimed_at: null })
    }
    return reply(route, 200, { id, link: `https://app.test/#/r/tok-${id}-${server.calls.length}`, email, expiresAt: EXPIRES, emailed: server.mode === 'emailed', ...(server.mode === 'emailed' ? {} : { reason: 'no-mailer' }) })
  }
  if (path === '/rest/v1/rpc/send_report') {
    const body = JSON.parse(req.postData())
    server.rpcs.push({ name: 'send_report', body })
    const row = { id: `d${++server.seq}`, token: 'tok-direct', recipient_email: body.p_recipient_email, link_expires_at: EXPIRES, sent_at: new Date().toISOString(), opened_at: null, claimed_at: null }
    server.deliveries.unshift(row)
    return reply(route, 200, row)
  }
  if (path === '/rest/v1/rpc/revoke_report') {
    const body = JSON.parse(req.postData())
    server.rpcs.push({ name: 'revoke_report', body })
    server.deliveries = server.deliveries.filter(d => d.id !== body.p_delivery_id)
    return route.fulfill({ status: 204, headers: cors })
  }
  if (path === '/rest/v1/report_deliveries' && req.method() === 'GET') {
    server.lastList = url.search
    return reply(route, 200, server.deliveries)
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

  // ── Finding a [timeframe] in the snapshot ──────────────────────────────────
  const found = await page.evaluate(async () => {
    const { unfinishedIn } = await import('/src/lib/sendReport.js')
    return {
      none: unfinishedIn({ site: { failed: [{ note: 'Replace within 7 days' }] }, rooms: [{ name: 'Bedroom', failed: [] }] }),
      site: unfinishedIn({ site: { failed: [{ note: 'Replace within [timeframe]', unfinished: true }] }, rooms: [] }),
      room: unfinishedIn({ site: null, rooms: [{ name: 'Bedroom 2', failed: [{ unfinished: true }] }, { name: '', failed: [{ unfinished: true }] }] }),
    }
  })
  log('a finished snapshot has nothing waiting', found.none.length === 0)
  log('a [timeframe] in the whole-site step is found', JSON.stringify(found.site) === '["the whole-site step"]')
  log('…and in each room, by name', JSON.stringify(found.room) === '["Bedroom 2","a room"]', JSON.stringify(found.room))

  if (!configured) {
    console.log('(the sending checks need VITE_SUPABASE_URL in .env, and were skipped; nothing is sent there)')
  } else {
    // A client with a contact email and a finished smoke alarm inspection.
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/templateStore.js')).pop()
      const { getTemplate } = await import(url ?? '/src/lib/templateStore.js')
      const now = new Date().toISOString()
      localStorage.setItem('fc.clients', JSON.stringify([{
        id: 'c1', name: 'Rental Co', contactName: 'Pat', contactEmail: 'owner@landlord.test', contactPhone: '', remindersEnabled: true,
        locations: [{
          id: 'l1', address: '10 Smith St', suburb: 'Toowong', city: 'Brisbane', state: 'QLD', postcode: '4066',
          floors: [{ id: 'f1', label: 'Upstairs', rooms: [{ id: 'b1', name: 'Bedroom 1', planNumber: '', roomType: 'bedroom' }] }],
          assets: [],
          visits: [{
            id: '33333333-3333-4333-8333-333333333333', kind: 'qld_smoke_alarm', technician: 'Sam Sparks', startedAt: now, completedAt: now,
            rooms: {}, exports: [], outcome: 'compliant',
            signoff: { technician: 'Sam Sparks', licence_number: 'QLD-77', signed_at: now, signature: 'M10 10 L100 50' },
            siteResults: { template: getTemplate('qld_smoke_alarm'), results: {}, readings: {}, sections: {}, troubleshooting: {}, comments: '' },
          }],
        }],
      }]))
    })
    const openSite = async () => {
      await page.goto(BASE + '#/qld-smoke-alarm', { waitUntil: 'networkidle' })
      await page.reload({ waitUntil: 'networkidle' })
      await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
      await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
    }
    const asTeam = () =>
      page.evaluate(
        async ({ team, e }) => {
          const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
          const mod = await import(url ?? '/src/lib/entitlements.js')
          await mod.openEntitlements(team, 'user', { getEntitlements: async () => e })
        },
        { team: TEAM, e: ENTITLEMENTS },
      )
    const sendButton = () => page.getByRole('button', { name: 'Send report', exact: true })
    const dialog = () => page.getByRole('dialog', { name: 'Send report' })
    const main = () => page.textContent('main')
    const revisions = () => page.locator('li').filter({ hasText: /^Revision \d/ }).count()
    const send = async () => {
      await sendButton().click()
      await dialog().getByRole('button', { name: 'Send report' }).click()
    }

    // ── No team ───────────────────────────────────────────────────────────────
    await openSite()
    log('with no team there\'s nothing to send from', (await sendButton().count()) === 0)
    log('…and nothing is asked of the backend', server.asked.length === 0, server.asked.join(' | '))

    // ── A team, a finished visit ──────────────────────────────────────────────
    await asTeam()
    await page.locator('button').filter({ hasText: /^Back|←/ }).first().click().catch(() => {})
    await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click().catch(() => {})
    log('a finished visit offers "Send report"', await until(async () => (await sendButton().count()) === 1))

    // A visit finished with a whole-site fail whose note still says [timeframe]
    // (as one finished before that was checked could be): refused on the device.
    const waiting = await page.evaluate(async () => {
      const mod = name => performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes(`/src/lib/${name}`)).pop() ?? `/src/lib/${name}`
      const { getTemplate } = await import(mod('templateStore.js'))
      const { scopeOf, typeOf } = await import(mod('testTypes.js'))
      const { sendReport } = await import(mod('sendReport.js'))
      const template = getTemplate('qld_smoke_alarm')
      const section = template.sections.find(s => scopeOf(s) === 'site' && s.tests.some(t => typeOf(t) !== 'text'))
      const test = section.tests.find(t => typeOf(t) !== 'text')
      const value = typeOf(test) === 'yesno' ? 'NO' : typeOf(test) === 'choice' ? test.failOptions[0] : 'FAIL'
      const now = new Date().toISOString()
      const visit = {
        id: 'v-waiting', kind: 'qld_smoke_alarm', startedAt: now, completedAt: now, rooms: {}, exports: [],
        siteResults: { template, results: { [section.id]: { [test.id]: value } }, readings: {}, sections: {}, troubleshooting: { [test.id]: 'Replace within [timeframe]' }, comments: '' },
      }
      try {
        await sendReport({ email: 'owner@landlord.test', client: { name: 'Rental Co' }, location: {}, visit, rooms: [], assets: [], revision: 1, reportTitle: 'X', settings: {} })
        return { sent: true }
      } catch (e) {
        return { message: e.message, hint: e.hint }
      }
    })
    log('a note still saying [timeframe] is refused on the device', waiting.hint === 'unfinished' && /whole-site step still says \[timeframe\]/.test(waiting.message ?? ''), JSON.stringify(waiting))
    log('…before anything is uploaded or sent', server.uploads.length === 0 && server.calls.length === 0)
    await sendButton().click()
    const field = dialog().getByLabel('Send to')
    log('the client\'s contact email is filled in', (await field.inputValue()) === 'owner@landlord.test')
    await field.fill('not an address')
    log('something that isn\'t an address can\'t be sent to', await dialog().getByRole('button', { name: 'Send report' }).isDisabled())
    await field.fill('owner@landlord.test')
    await ctx.setOffline(true)
    log('with no connection it says so, and won\'t send',
      await until(async () => /needs a connection/.test(await dialog().textContent()) && (await dialog().getByRole('button', { name: 'Send report' }).isDisabled())))
    await ctx.setOffline(false)
    await until(async () => !(await dialog().getByRole('button', { name: 'Send report' }).isDisabled()))
    await page.screenshot({ path: `${DIR}/send-dialog.png` })

    // ── It goes ──────────────────────────────────────────────────────────────
    await dialog().getByRole('button', { name: 'Send report' }).click()
    log('it says it was emailed, with the link as well', await until(async () => /Report sent to owner@landlord\.test\./.test(await main())), (await main()).slice(0, 300))
    const up = server.uploads[0]
    const call = server.calls[0] ?? {}
    log('the PDF went to the team\'s report folder, under a name of its own',
      server.uploads.length === 1 && new RegExp(`^${TEAM}/[0-9a-f-]{36}\\.pdf$`).test(up.name) && up.body.includes(Buffer.from('%PDF-')), up?.name)
    log('…before the function was asked', server.asked.findIndex(a => a.includes('/object/reports/')) < server.asked.findIndex(a => a.includes('/deliver-report')))
    log('the function got the visit, the address and that file',
      call.action === 'send' && call.visitId === '33333333-3333-4333-8333-333333333333' && call.email === 'owner@landlord.test' && call.filePath === up?.name,
      JSON.stringify({ ...call, snapshot: undefined }))
    log('…the snapshot, as revision 1', call.snapshot?.revision === 1 && call.snapshot?.reportTitle === 'Smoke Alarm Compliance Inspection' && call.snapshot?.client === 'Rental Co')
    log('…a title for the email, and where the app lives', call.title === 'Smoke Alarm Compliance Inspection report' && call.appUrl === BASE.replace(/\/?$/, '/'), `${call.title} ${call.appUrl}`)
    log('the send is recorded as revision 1', (await revisions()) === 1)
    log('and listed under Sent, with "Send again" and "Withdraw"',
      await until(async () => (await page.getByRole('button', { name: 'Send again to owner@landlord.test' }).count()) === 1)
      && (await page.getByRole('button', { name: 'Withdraw the report sent to owner@landlord.test' }).count()) === 1
      && /visit_id=eq\.33333333/.test(server.lastList ?? ''))
    await page.screenshot({ path: `${DIR}/send-sent.png`, fullPage: true })

    // ── A second one asks, as Export PDF does ───────────────────────────────
    await send()
    const ask = page.getByRole('dialog', { name: 'Export report' })
    log('a second send asks: a new revision, or replace', await until(async () => (await ask.count()) === 1))
    await ask.getByRole('button', { name: /Save as Revision 2/ }).click()
    await until(async () => server.calls.length === 2)
    log('…and goes as revision 2', server.calls[1]?.snapshot?.revision === 2 && (await until(async () => (await revisions()) === 2)))

    // ── Refused over the cap ─────────────────────────────────────────────────
    server.mode = 'cap'
    await send()
    await ask.getByRole('button', { name: /Save as Revision 3/ }).click()
    log('over the cap, the database\'s words are shown', await until(async () => /sent its 10 reports for the last 24 hours/.test(await main())))
    log('…and no revision is recorded', (await revisions()) === 2)

    // ── No mailer ────────────────────────────────────────────────────────────
    server.mode = 'nomailer'
    await send()
    await ask.getByRole('button', { name: /Save as Revision 3/ }).click()
    log('with no mailer it says not emailed, and hands over the link',
      await until(async () => /Report recorded for owner@landlord\.test, but not emailed\./.test(await main()))
      && /Send them this link yourself/.test(await main()) && (await page.getByRole('button', { name: 'Copy link' }).count()) >= 1)

    // ── The function not deployed yet ───────────────────────────────────────
    server.mode = 'missing'
    await send()
    await ask.getByRole('button', { name: /Save as Revision 4/ }).click()
    log('with no function yet it records the report itself', await until(async () => server.rpcs.some(r => r.name === 'send_report')))
    const direct = server.rpcs.find(r => r.name === 'send_report')?.body ?? {}
    log('…with the same visit, address, file and snapshot',
      direct.p_visit_id === '33333333-3333-4333-8333-333333333333' && direct.p_recipient_email === 'owner@landlord.test'
      && direct.p_file_path === server.uploads.at(-1)?.name && direct.p_snapshot?.revision === 4)
    log('…and hands over its link, never saying emailed',
      await until(async () => (await main()).includes(`${BASE.replace(/\/?$/, '/')}#/r/tok-direct`)) && /but not emailed/.test(await main()))

    // ── Send again, Withdraw ────────────────────────────────────────────────
    server.mode = 'emailed'
    server.deliveries.push({ id: 'saved-1', recipient_email: 'kept@landlord.test', sent_at: '2026-10-01T00:00:00Z', link_expires_at: EXPIRES, opened_at: '2026-10-02T00:00:00Z', claimed_at: '2026-10-02T00:00:00Z' })
    await page.reload({ waitUntil: 'networkidle' })
    await asTeam()
    await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click().catch(() => {})
    await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click().catch(() => {})
    await until(async () => (await page.getByRole('button', { name: 'Send again to kept@landlord.test' }).count()) === 1)
    log('a report they\'ve saved says so, and can\'t be withdrawn',
      /Saved by them/.test(await main()) && (await page.getByRole('button', { name: 'Withdraw the report sent to kept@landlord.test' }).count()) === 0)
    const first = server.deliveries.find(d => d.id === 'd1')
    const before = server.calls.length
    await page.getByRole('button', { name: 'Send again to owner@landlord.test' }).first().click()
    await until(async () => server.calls.length > before)
    const again = server.calls.at(-1)
    log('"Send again" asks the function to resend that delivery', again?.action === 'resend' && again?.deliveryId === server.deliveries.find(d => d.recipient_email === 'owner@landlord.test')?.id && !again.email, JSON.stringify(again))
    log('…and says it went again', await until(async () => /Report sent again to owner@landlord\.test\./.test(await main())))

    const left = server.deliveries.length
    const target = server.deliveries.find(d => d.recipient_email === 'owner@landlord.test')
    await page.getByRole('button', { name: 'Withdraw the report sent to owner@landlord.test' }).first().click()
    const confirm = page.getByRole('dialog', { name: /Withdraw the report sent to owner@landlord\.test/ })
    log('withdrawing asks first, and says it still counts', /still counts towards today/.test(await confirm.textContent()))
    await confirm.getByRole('button', { name: 'Withdraw' }).click()
    log('…then withdraws that one report', await until(async () => server.rpcs.some(r => r.name === 'revoke_report' && r.body.p_delivery_id === target.id) && server.deliveries.length === left - 1))
    log('…and the list follows', await until(async () => (await page.getByRole('button', { name: /Send again to/ }).count()) === server.deliveries.length))
    void first
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
