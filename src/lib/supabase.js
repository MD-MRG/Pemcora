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

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null
