// What the Auth server last said when it refused to renew this device's login
// (build plan C5).
//
// The login library signs out by itself when the Auth server refuses a renewal,
// but doesn't say why. Ended from another device and anything else look the same
// from outside, so this notes the server's own error code on the way past. It is
// read from the code, never from the message text. A renewal that fails for want
// of a connection gets no answer at all, so it notes nothing (B3b's case).
//
// No token passes through here: only the URL is looked at, and the refusal's
// error code read from its body.

// The codes that mean this login no longer exists: its row was deleted, by
// end_device() or "Sign out all other devices".
const ENDED = new Set(['refresh_token_not_found', 'session_not_found'])

let refusal = null

const isRenewal = input => /\/auth\/v1\/token\?(.*&)?grant_type=refresh_token/.test(String(input?.url ?? input))

/** Wraps a fetch so a refused renewal's error code is noted. */
export const watchRenewals = fetchImpl => async (input, init) => {
  const response = await fetchImpl(input, init)
  if (isRenewal(input)) {
    if (response.ok) {
      refusal = null
    } else {
      const body = await response
        .clone()
        .json()
        .catch(() => null)
      refusal = typeof body?.error_code === 'string' ? body.error_code : 'unknown'
    }
  }
  return response
}

/** The error code of the last refused renewal, or null. */
export const lastRenewalRefusal = () => refusal

/** Whether that refusal means the login was ended, from this device or another. */
export const loginWasEnded = (code = refusal) => ENDED.has(code)

export const forgetRenewalRefusal = () => {
  refusal = null
}
