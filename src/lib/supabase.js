import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// True only when both env vars are present. Lets the app boot and show a clear
// "not configured" screen instead of crashing when env is missing — which is
// exactly what a GitHub Pages build without the Actions secrets would produce.
export const isSupabaseConfigured = Boolean(url && anonKey)

// Lets the ten headless suites drive the real UI without a backend, an account,
// or writing test data into the live project: the auth gate is bypassed and the
// stores stay on localStorage. Suites set the flag with addInitScript before the
// first navigation.
//
// `import.meta.env.DEV` is the part that matters. It is false in every built
// bundle, so a production build ignores the flag entirely and no amount of
// fiddling with localStorage on the deployed site can bypass the gate. (Even if
// it could, there would be nothing behind it — RLS refuses an unauthenticated
// caller server-side, so a bypassed gate shows an empty app, not other people's
// data.)
//
// Deliberately NOT "fall back to local when Supabase is missing": a deployed
// build that lost its secrets must fail loudly with the not-configured screen,
// not quietly become a local-only app whose data nobody else can see.
export const isTestMode =
  import.meta.env.DEV &&
  (() => {
    try {
      return localStorage.getItem('fc.testMode') === '1'
    } catch {
      return false
    }
  })()

/**
 * Where a confirmation email should send someone back to.
 *
 * Without this, `signUp` sends no `redirect_to` at all — auth-js only forwards
 * `options.emailRedirectTo` — and GoTrue falls back to the project's Site URL.
 * That fallback is invisible from the code and was set to the bare origin, so
 * confirmation links arrived pointing at https://md-mrg.github.io/ instead of
 * the app, and GitHub answered "There isn't a GitHub Pages site here". The
 * address was never verified, because the link never reached /auth/v1/verify's
 * redirect in a usable state.
 *
 * Deliberately `location.pathname`, NOT `import.meta.env.BASE_URL`: vite.config
 * sets `base: './'` so a Pages deploy works at any sub-path, which makes
 * BASE_URL the literal string './' — and origin + './' is
 * "https://md-mrg.github.io./", a hostname that does not exist.
 *
 * HashRouter keeps pathname at the app root whatever route you are on, so this
 * is the deploy root on GitHub Pages ("/Pemcora/") and "/" on a dev server —
 * which is why both are on the redirect allow list.
 */
export const emailRedirectUrl = () => window.location.origin + window.location.pathname

/**
 * Did we arrive here from a password-reset email?
 *
 * Evaluated at module load, which is the only moment it can be: this statement
 * runs before the createClient call below, and `detectSessionInUrl` reads the
 * recovery hash and then erases it. By the time React has mounted there is
 * nothing left in the URL to look at.
 *
 * AuthContext also listens for the PASSWORD_RECOVERY event, but that fires from
 * inside the client's async initialisation and can land before any listener is
 * registered. This flag cannot be missed, so it is the one that decides.
 */
export const isPasswordRecovery =
  typeof window !== 'undefined' &&
  `${window.location.hash}&${window.location.search}`.includes('type=recovery')

/**
 * The token from an invitation link, if this is one.
 *
 * A query parameter rather than part of the hash, because the hash belongs to
 * HashRouter — anything put there is a route, and `#/?invite=…` would have to
 * survive a router that rewrites it. `?invite=…` is untouched by both the
 * router and by GoTrue's own hash handling.
 */
export const inviteTokenInUrl =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('invite')
    : null

// Drop it from the address bar once it has been dealt with, so a reload does
// not reopen an invitation that has already been taken up or declined.
export const clearInviteFromUrl = () => {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.delete('invite')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
}

export const inviteUrl = token => `${emailRedirectUrl()}?invite=${encodeURIComponent(token)}`

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null
