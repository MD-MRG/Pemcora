import { useEffect, useState } from 'react'
import {
  supabase,
  isSupabaseConfigured,
  isPasswordRecovery,
  emailRedirectUrl,
} from '../lib/supabase.js'
import { AuthContext } from './auth.js'

const notConfigured = { error: { message: 'Pemcora is not connected to a backend.' } }

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  // A recovery link signs you in. That is the whole mechanism — the link IS the
  // proof — so without this flag a reset email would drop someone into the app
  // still holding the password they could not remember.
  const [recovering, setRecovering] = useState(isPasswordRecovery)

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const value = {
    configured: isSupabaseConfigured,
    loading,
    session,
    user: session?.user ?? null,
    recovering,
    signIn: (email, password) =>
      supabase
        ? supabase.auth.signInWithPassword({ email, password })
        : Promise.resolve(notConfigured),
    // emailRedirectTo is what puts `redirect_to` on the confirmation link.
    // Omit it and the link's destination comes from a dashboard setting no
    // one can see from here — see emailRedirectUrl.
    //
    // `data` rides along into raw_user_meta_data, which is where an invite
    // token has to live: it is the only thing that survives from this call
    // through the confirmation email to the trigger that reads it back.
    signUp: (email, password, data) =>
      supabase
        ? supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: emailRedirectUrl(), ...(data ? { data } : {}) },
          })
        : Promise.resolve(notConfigured),
    // Same redirect as a confirmation link. GoTrue appends its own
    // `type=recovery` hash, which is what isPasswordRecovery reads.
    resetPassword: email =>
      supabase
        ? supabase.auth.resetPasswordForEmail(email, { redirectTo: emailRedirectUrl() })
        : Promise.resolve(notConfigured),
    updatePassword: password =>
      supabase ? supabase.auth.updateUser({ password }) : Promise.resolve(notConfigured),
    endRecovery: () => setRecovering(false),
    signOut: () => (supabase ? supabase.auth.signOut() : Promise.resolve({})),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
