/**
 * Step C5c: telling a login ended elsewhere from a renewal that just failed.
 *
 * Not a browser suite: it drives src/lib/renewal.js in Node with a stand-in for
 * fetch. tests/offline-open.mjs plays the whole thing in a built app.
 *
 *   node tests/renewal.mjs
 *
 * What it holds the code to:
 *   - a refused renewal's error code is noted, from the code, never the message
 *   - a renewal that never got an answer notes nothing
 *   - a renewal that works forgets the last refusal
 *   - nothing else is looked at
 */
const { forgetRenewalRefusal, lastRenewalRefusal, loginWasEnded, watchRenewals } = await import('../src/lib/renewal.js')

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

const RENEW = 'https://x.supabase.co/auth/v1/token?grant_type=refresh_token'
const answer = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const call = async (fetchImpl, url = RENEW) => {
  try {
    return await watchRenewals(fetchImpl)(url, { method: 'POST' })
  } catch (e) {
    return e
  }
}

let res = await call(answer(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }))
log('a renewal refused because the login is gone is noted by its code', lastRenewalRefusal() === 'refresh_token_not_found' && loginWasEnded())
log('and the library still gets the answer, unread', res.status === 400 && (await res.json()).error_code === 'refresh_token_not_found')

await call(answer(200, { access_token: 'a', refresh_token: 'r' }))
log('a renewal that works forgets it', lastRenewalRefusal() === null && !loginWasEnded())

await call(answer(400, { code: 400, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' }))
log('a session that no longer exists counts too', loginWasEnded())
forgetRenewalRefusal()

await call(answer(400, { code: 400, error_code: 'refresh_token_already_used', msg: 'Refresh Token Not Found' }))
log('another refusal is noted, but isn\'t an ended login, whatever its message says',
  lastRenewalRefusal() === 'refresh_token_already_used' && !loginWasEnded())

await call(answer(400, { msg: 'Refresh Token Not Found' }))
log('one with no code isn\'t taken from its message', lastRenewalRefusal() === 'unknown' && !loginWasEnded())
forgetRenewalRefusal()

res = await call(async () => {
  throw new TypeError('Failed to fetch')
})
log('a renewal that never got an answer notes nothing, and fails as before', lastRenewalRefusal() === null && res instanceof TypeError)

await call(answer(400, { error_code: 'refresh_token_not_found' }), 'https://x.supabase.co/rest/v1/visits')
log('nothing but a renewal is looked at', lastRenewalRefusal() === null)
await call(answer(400, { error_code: 'invalid_credentials' }), 'https://x.supabase.co/auth/v1/token?grant_type=password')
log('not even a password sign-in', lastRenewalRefusal() === null)
await call(answer(400, { error_code: 'refresh_token_not_found' }), new Request(RENEW, { method: 'POST' }))
log('a renewal sent as a Request is seen too', lastRenewalRefusal() === 'refresh_token_not_found')
