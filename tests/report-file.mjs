/**
 * Step D3b: the report-file Edge Function.
 *
 * Not a browser suite. It loads the function itself, index.ts, in Node: Node
 * strips its types, a hook stands in for the Supabase client, and `Deno` and the
 * database's answers are stand-ins too. tests/report-link.mjs drives the page's
 * "Open the PDF" against it.
 *
 *   node tests/report-file.mjs
 *
 * What it holds the function to:
 *   - a link only while report_preview() would show the report: not for one
 *     saved to an account, past its 90 days, or with no PDF
 *   - it reads one row, by token, and never the recipient's address
 *   - it signs exactly that report's file, for five minutes
 *   - a token that isn't one asks the database nothing
 */
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const A = await import('../supabase/functions/report-file/access.js')
const NOW = Date.parse('2026-11-09T00:00:00Z')
const ROW = { file_path: 'team-1/abc.pdf', link_expires_at: '2027-02-01T00:00:00Z', claimed_at: null, recipient_team_id: null }

// ── access.js ───────────────────────────────────────────────────────────────
log('a working link may have its PDF', A.fileAccess(ROW, NOW).ok === true && A.fileAccess(ROW, NOW).path === 'team-1/abc.pdf')
log('no row: not valid', A.fileAccess(null, NOW).status === 404 && A.fileAccess(null, NOW).body.status === 'invalid')
log('saved by its recipient: not through the link', A.fileAccess({ ...ROW, claimed_at: '2026-11-08T00:00:00Z' }, NOW).body?.status === 'saved')
log('…nor filed into an account', A.fileAccess({ ...ROW, recipient_team_id: 't2' }, NOW).body?.status === 'saved')
log('saved wins over expired, as on the page', A.fileAccess({ ...ROW, claimed_at: 'x', link_expires_at: '2020-01-01T00:00:00Z' }, NOW).body?.status === 'saved')
log('past its 90 days: expired', A.fileAccess({ ...ROW, link_expires_at: '2026-11-08T23:59:59Z' }, NOW).status === 410)
log('…to the second, as the database counts it', A.fileAccess({ ...ROW, link_expires_at: '2026-11-09T00:00:00Z' }, NOW).body?.status === 'expired')
log('…and with no expiry on record, expired too', A.fileAccess({ ...ROW, link_expires_at: null }, NOW).body?.status === 'expired')
log('no PDF: says so', A.fileAccess({ ...ROW, file_path: null }, NOW).body?.status === 'no-file')
log('the link lasts five minutes', A.LINK_SECONDS === 300)
log('it reads only the four columns it decides by, never the recipient\'s address',
  JSON.stringify(A.COLUMNS.split(',').map(c => c.trim()).sort()) === JSON.stringify(['claimed_at', 'file_path', 'link_expires_at', 'recipient_team_id']), A.COLUMNS)

// ── index.ts, the handler ───────────────────────────────────────────────────
const SOURCE = readFileSync(new URL('../supabase/functions/report-file/index.ts', import.meta.url), 'utf8')
log('the deploy note says the platform\'s login check is off', SOURCE.includes('--no-verify-jwt'))

const STUB = 'data:text/javascript,' + encodeURIComponent('export const createClient = (...a) => globalThis.__supabase(...a)')
registerHooks({
  resolve: (spec, ctx, next) => (spec.startsWith('jsr:@supabase/supabase-js') ? { url: STUB, shortCircuit: true } : next(spec, ctx)),
})

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key' }
let handler
globalThis.Deno = { serve: h => (handler = h), env: { get: k => env[k] } }

let made
let row = ROW
let lookupFails = false
let signFails = false
const asked = []
const signed = []
globalThis.__supabase = (url, key, options) => {
  made = { url, key, options }
  return {
    from: table => ({
      select: columns => ({
        eq: (column, value) => ({
          maybeSingle: async () => {
            asked.push({ table, columns, column, value })
            return lookupFails ? { data: null, error: { message: 'boom' } } : { data: row, error: null }
          },
        }),
      }),
    }),
    storage: {
      from: bucket => ({
        createSignedUrl: async (path, seconds) => {
          signed.push({ bucket, path, seconds })
          return signFails ? { data: null, error: { message: 'Object not found' } } : { data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=s` }, error: null }
        },
      }),
    },
  }
}

await import('../supabase/functions/report-file/index.ts')
log('the function starts', typeof handler === 'function')

const TOKEN = '6f1c2a9e-4b7d-4e2f-9a31-0c5d8e7f6a21'
const call = async (body, init = {}) => {
  const res = await handler(new Request('https://x.supabase.co/functions/v1/report-file', { method: 'POST', body: JSON.stringify(body), ...init }))
  return { status: res.status, body: await res.json().catch(() => null) }
}
const reset = () => {
  asked.length = 0
  signed.length = 0
  made = null
}

const pre = await handler(new Request('https://x', { method: 'OPTIONS' }))
log('a preflight is answered', pre.status === 200)

reset()
let r = await call({ token: TOKEN.toUpperCase() })
log('with no login at all, a working link gets its PDF', r.status === 200 && r.body.url === 'https://x.supabase.co/storage/v1/object/sign/reports/team-1/abc.pdf?token=s' && r.body.expiresIn === 300, JSON.stringify(r.body))
log('…reading that one delivery, by its token', asked.length === 1 && asked[0].table === 'report_deliveries' && asked[0].column === 'token' && asked[0].value === TOKEN && asked[0].columns === A.COLUMNS)
log('…and signing exactly its file, in the report bucket, for five minutes', signed.length === 1 && signed[0].bucket === 'reports' && signed[0].path === 'team-1/abc.pdf' && signed[0].seconds === 300)
log('…with the platform\'s key, which stays in the function', made?.key === 'service-key' && made?.options?.auth?.persistSession === false)

for (const [what, token] of [['no token', undefined], ['a token that isn\'t one', 'abc'], ['a path in its place', '../team-1/abc.pdf']]) {
  reset()
  r = await call({ token })
  log(`${what}: refused, asking the database nothing`, r.status === 400 && r.body.status === 'invalid' && asked.length === 0 && signed.length === 0)
}
reset()
r = await handler(new Request('https://x.supabase.co/functions/v1/report-file', { method: 'POST', body: 'not json' }))
log('a body that isn\'t JSON is refused', r.status === 400 && asked.length === 0)
r = await handler(new Request('https://x.supabase.co/functions/v1/report-file', { method: 'GET' }))
log('only POST', r.status === 405)

for (const [what, value, status] of [
  ['an unknown token', null, 404],
  ['a saved report', { ...ROW, claimed_at: '2026-11-08T00:00:00Z' }, 403],
  ['an expired link', { ...ROW, link_expires_at: '2020-01-01T00:00:00Z' }, 410],
  ['a report with no PDF', { ...ROW, file_path: null }, 404],
]) {
  reset()
  row = value
  r = await call({ token: TOKEN })
  log(`${what}: ${status}, and no file link`, r.status === status && !r.body.url && signed.length === 0, JSON.stringify(r.body))
}
row = ROW

reset()
lookupFails = true
r = await call({ token: TOKEN })
log('a lookup that fails says try again, and signs nothing', r.status === 500 && /Try again/.test(r.body.error) && signed.length === 0)
lookupFails = false

reset()
signFails = true
r = await call({ token: TOKEN })
log('a file that isn\'t there says so', r.status === 404 && r.body.status === 'no-file' && !r.body.url)
signFails = false
