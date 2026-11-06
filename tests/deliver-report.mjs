/**
 * Step D2b: the deliver-report Edge Function.
 *
 * Not a browser suite. It loads the function itself, index.ts, in Node: Node
 * strips its types, a hook stands in for the Supabase client it imports, and
 * `Deno`, the database's answers and Resend are stand-ins too. So what's checked
 * is the handler as deployed, minus the network.
 *
 *   node tests/deliver-report.mjs
 *
 * What it holds the function to:
 *   - it calls send_report() / resend_report() with the caller's own login, never
 *     a service key
 *   - a refusal comes back with its code and hint, the cap as a 429, and nothing
 *     is emailed
 *   - the email's business, site and date come from the row the database wrote,
 *     not the request; "Send again" goes to the address it was first sent to
 *   - From is Pemcora's address named "<business> via Pemcora", replies go to
 *     the business, and nothing typed can add a header or HTML
 *   - with no mailer, or a mailer that fails, the link still comes back
 */
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const M = await import('../supabase/functions/deliver-report/message.js')

// ── message.js ───────────────────────────────────────────────────────────────
log('a typed name loses its line breaks and control characters', M.oneLine('Sparky\r\nBcc: x@y.z\u0007 Co') === 'Sparky Bcc: x@y.z Co')
log('…and is cut short', M.oneLine('x'.repeat(200), 60).length === 60)

const FROM = 'Pemcora <reports@pemcora.app>'
log('From is Pemcora\'s address, named after the business', M.fromLine(FROM, 'Sparky Co') === '"Sparky Co via Pemcora" <reports@pemcora.app>', M.fromLine(FROM, 'Sparky Co'))
const sly = M.fromLine(FROM, 'Evil" <boss@bank.test>\r\nBcc: all@x.test')
log('…and a name can\'t end itself early, add an address or a header', sly === '"Evil boss@bank.test Bcc: all@x.test via Pemcora" <reports@pemcora.app>', sly)
log('…with no business name it\'s just Pemcora', M.fromLine(FROM, '  ') === '"Pemcora" <reports@pemcora.app>')
log('…a bare address in INVITE_FROM works too', M.fromLine('reports@pemcora.app', 'A') === '"A via Pemcora" <reports@pemcora.app>')
log('…and with none set, Resend\'s test sender', M.fromLine(undefined, 'A') === '"A via Pemcora" <onboarding@resend.dev>')

log('replies go to the business\'s email', M.replyTo('office@sparky.test', 'me@sparky.test') === 'office@sparky.test')
log('…or, with none in Settings, the person who sent it', M.replyTo('', 'me@sparky.test') === 'me@sparky.test')
log('…and never to something that isn\'t one address', M.replyTo('a@b.test\nBcc: c@d.test', 'x@y.test, z@w.test') === null)

log('the link is the app\'s report page', M.reportLink('https://md-mrg.github.io/pemcora/', 'ab/c') === 'https://md-mrg.github.io/pemcora/#/r/ab%2Fc')
log('the site reads as one line', M.siteLine({ address: '10 Smith St', suburb: 'Richmond', state: 'VIC', postcode: '3121' }) === '10 Smith St, Richmond VIC 3121')
log('a date is written out', M.longDate('2026-11-06') === '6 November 2026', M.longDate('2026-11-06'))
log('…and a moment as its day in Sydney', M.longDate('2027-02-04T14:00:00Z') === '5 February 2027', M.longDate('2027-02-04T14:00:00Z'))

const cap = M.refusal({ code: 'PT429', hint: 'send_cap', message: 'Your team has sent its 10 reports for the last 24 hours. Try again later.' })
log('the daily cap is a 429 with its hint', cap.status === 429 && cap.body.hint === 'send_cap' && cap.body.code === 'PT429' && /10 reports/.test(cap.body.error))
const unfinished = M.refusal({ code: '23514', hint: 'unfinished', message: 'A note in this report still says [timeframe].' })
log('an unfinished note is a 400 with its hint', unfinished.status === 400 && unfinished.body.hint === 'unfinished')

const mail = M.emailBody({
  business: 'Sparky <b>Co</b>',
  title: 'Electrical safety check\nreport <script>alert(1)</script>',
  site: { address: '10 Smith St', suburb: 'Richmond', state: 'VIC', postcode: '3121' },
  completedOn: '2026-11-06',
  link: 'https://app.test/#/r/tok',
  expiresAt: '2027-02-04T14:00:00Z',
  reply: 'office@sparky.test',
})
log('the subject is one line, with the business and site', !/[\r\n]/.test(mail.subject) && mail.subject.includes('Sparky <b>Co</b>') && mail.subject.includes('10 Smith St, Richmond VIC 3121'), mail.subject)
log('nothing typed becomes HTML', !mail.html.includes('<script>') && !mail.html.includes('<b>Co</b>') && mail.html.includes('&lt;script&gt;'))
log('the text says what, where, when, and until when the link works',
  ['the Electrical safety check report', '10 Smith St', '6 November 2026', 'https://app.test/#/r/tok', 'until 5 February 2027'].every(s => mail.text.includes(s)))
log('…and that a reply reaches the business', mail.text.includes('Reply to this email to reach Sparky <b>Co</b>'))
log('…but only when there\'s somewhere for it to go', !M.emailBody({ business: 'A', link: 'l' }).text.includes('Reply to this email'))

// ── index.ts, the handler ────────────────────────────────────────────────────
const SOURCE = readFileSync(new URL('../supabase/functions/deliver-report/index.ts', import.meta.url), 'utf8')
log('the function never reads the service-role key', !/service_role|SERVICE_ROLE/i.test(SOURCE))

const STUB = 'data:text/javascript,' + encodeURIComponent('export const createClient = (...a) => globalThis.__supabase(...a)')
registerHooks({
  resolve: (spec, ctx, next) => (spec.startsWith('jsr:@supabase/supabase-js') ? { url: STUB, shortCircuit: true } : next(spec, ctx)),
})

const env = {}
let handler
globalThis.Deno = { serve: h => (handler = h), env: { get: k => env[k] } }

// What the database answers, and what was asked of it.
let answer
let made
const rpcs = []
globalThis.__supabase = (url, key, options) => {
  made = { url, key, options }
  return {
    rpc: async (name, args) => {
      rpcs.push({ name, args })
      return answer
    },
    auth: { getUser: async () => ({ data: { user: { email: 'me@sparky.test' } } }) },
  }
}

// Resend.
const mails = []
let resendSays = { status: 200, body: '{"id":"m1"}' }
globalThis.fetch = async (url, init) => {
  mails.push({ url, init, body: JSON.parse(init.body) })
  return new Response(resendSays.body, { status: resendSays.status })
}

await import('../supabase/functions/deliver-report/index.ts')
log('the function starts', typeof handler === 'function')

const ROW = {
  id: 'd-1',
  token: 'tok-1',
  recipient_email: 'owner@landlord.test',
  link_expires_at: '2027-02-04T14:00:00Z',
  completed_on: '2026-11-06',
  site: { address: '10 Smith St', suburb: 'Richmond', state: 'VIC', postcode: '3121' },
  snapshot: { provider: { name: 'Team name', company: { name: 'Sparky Co', email: 'office@sparky.test' } } },
}
const call = async (body, headers = { Authorization: 'Bearer caller-jwt' }) => {
  const res = await handler(new Request('https://x.supabase.co/functions/v1/deliver-report', { method: 'POST', headers, body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json().catch(() => null) }
}
const reset = () => {
  rpcs.length = 0
  mails.length = 0
  made = null
}

Object.assign(env, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon-key', INVITE_APP_URL: 'https://md-mrg.github.io/pemcora/' })

const pre = await handler(new Request('https://x', { method: 'OPTIONS' }))
log('a preflight is answered', pre.status === 200 && pre.headers.get('Access-Control-Allow-Origin') === '*')
log('signed out, nothing happens', (await call({ action: 'send' }, {})).status === 401 && rpcs.length === 0)
log('an unknown action is refused', (await call({ action: 'delete' })).status === 400 && rpcs.length === 0)

const SEND = {
  action: 'send',
  visitId: 'v-1',
  email: 'owner@landlord.test',
  filePath: 'team-1/abc.pdf',
  title: 'Electrical safety check report',
  snapshot: { site: { failed: [] }, provider: { name: 'Somebody Else' } },
}

// No mailer: sent, and the link comes back to hand over.
reset()
answer = { data: ROW, error: null }
let r = await call(SEND)
log('it sends as the caller: their login, the public key', made?.key === 'anon-key' && made?.options?.global?.headers?.Authorization === 'Bearer caller-jwt')
log('…through send_report(), with the visit, address, snapshot and file',
  rpcs.length === 1 && rpcs[0].name === 'send_report' && rpcs[0].args.p_visit_id === 'v-1' && rpcs[0].args.p_recipient_email === 'owner@landlord.test'
  && rpcs[0].args.p_file_path === 'team-1/abc.pdf' && JSON.stringify(rpcs[0].args.p_snapshot) === JSON.stringify(SEND.snapshot))
log('with no mailer the link comes back, not emailed', r.status === 200 && r.body.emailed === false && r.body.reason === 'no-mailer'
  && r.body.link === 'https://md-mrg.github.io/pemcora/#/r/tok-1' && r.body.id === 'd-1' && mails.length === 0, JSON.stringify(r.body))

// With a mailer.
env.RESEND_API_KEY = 're_test'
env.INVITE_FROM = 'Pemcora <reports@pemcora.app>'
reset()
r = await call(SEND)
const sent = mails[0]?.body ?? {}
log('with a mailer it emails once, through Resend', r.status === 200 && r.body.emailed === true && mails.length === 1
  && mails[0].url === 'https://api.resend.com/emails' && mails[0].init.headers.Authorization === 'Bearer re_test')
log('…to the address the report was sent to', JSON.stringify(sent.to) === '["owner@landlord.test"]')
log('…from Pemcora\'s address, named after the business the database wrote, not the request',
  sent.from === '"Sparky Co via Pemcora" <reports@pemcora.app>', sent.from)
log('…replies to the business', sent.reply_to === 'office@sparky.test')
log('…with the site and date from the delivery', sent.subject === 'Sparky Co: Electrical safety check report for 10 Smith St, Richmond VIC 3121'
  && sent.text.includes('6 November 2026') && sent.text.includes('https://md-mrg.github.io/pemcora/#/r/tok-1'), sent.subject)

// With no company email in Settings, replies go to whoever sent it.
reset()
answer = { data: { ...ROW, snapshot: { provider: { name: 'Team name', company: {} } } }, error: null }
await call(SEND)
log('no company email: replies go to the sender, and it\'s named after the team', mails[0]?.body.reply_to === 'me@sparky.test'
  && mails[0]?.body.from === '"Team name via Pemcora" <reports@pemcora.app>', mails[0]?.body.from)

// Send again: the database's address, whatever the request says.
reset()
answer = { data: { ...ROW, token: 'tok-2' }, error: null }
r = await call({ action: 'resend', deliveryId: 'd-1', email: 'someone@else.test', title: 'Electrical safety check report' })
log('"Send again" goes through resend_report()', rpcs.length === 1 && rpcs[0].name === 'resend_report' && rpcs[0].args.p_delivery_id === 'd-1')
log('…to the address it was first sent to, with the new link', JSON.stringify(mails[0]?.body.to) === '["owner@landlord.test"]'
  && r.body.link.endsWith('#/r/tok-2') && mails[0]?.body.text.includes('#/r/tok-2'))

// Refusals.
reset()
answer = { data: null, error: { code: 'PT429', hint: 'send_cap', message: 'Your team has sent its 10 reports for the last 24 hours. Try again later.' } }
r = await call(SEND)
log('over the cap: a 429 with the code, hint and message, and no email', r.status === 429 && r.body.hint === 'send_cap' && r.body.code === 'PT429'
  && /10 reports/.test(r.body.error) && mails.length === 0, JSON.stringify(r.body))
reset()
answer = { data: null, error: { code: '23514', hint: 'unfinished', message: 'A note in this report still says [timeframe]. Fill it in before sending.' } }
r = await call(SEND)
log('an unfinished note: a 400 with its hint, and no email', r.status === 400 && r.body.hint === 'unfinished' && mails.length === 0)

// The mailer fails: the report stands, and the link comes back.
reset()
answer = { data: ROW, error: null }
resendSays = { status: 422, body: '{"message":"The pemcora.app domain is not verified"}' }
r = await call(SEND)
log('a mailer that fails still hands back the link', r.status === 200 && r.body.emailed === false && /not verified/.test(r.body.reason)
  && r.body.link.endsWith('#/r/tok-1'), JSON.stringify(r.body))
resendSays = { status: 200, body: '{}' }

// Nowhere to point the link.
delete env.INVITE_APP_URL
reset()
r = await call(SEND)
log('with no INVITE_APP_URL and no matching origin, nothing is sent', r.status === 400 && /INVITE_APP_URL/.test(r.body.error) && rpcs.length === 0)
r = await call({ ...SEND, appUrl: 'https://md-mrg.github.io/pemcora/' }, { Authorization: 'Bearer caller-jwt', Origin: 'https://md-mrg.github.io' })
log('…but the page\'s own address will do', r.status === 200 && r.body.link === 'https://md-mrg.github.io/pemcora/#/r/tok-1', JSON.stringify(r.body))
