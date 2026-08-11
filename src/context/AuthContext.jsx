import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured, emailRedirectUrl } from '../lib/supabase.js'
import { AuthContext } from './auth.js'

const notConfigured = { error: { message: 'Pemcora is not connected to a backend.' } }

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false)
      return
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const value = {
    configured: isSupabaseConfigured,
    loading,
    session,
    user: session?.user ?? null,
    signIn: (email, password) =>
      supabase
        ? supabase.auth.signInWithPassword({ email, password })
        : Promise.resolve(notConfigured),
    // emailRedirectTo is what puts `redirect_to` on the confirmation link.
    // Omit it and the link's destination comes from a dashboard setting no
    // one can see from here — see emailRedirectUrl.
    signUp: (email, password) =>
      supabase
        ? supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: emailRedirectUrl() },
          })
        : Promise.resolve(notConfigured),
    signOut: () => (supabase ? supabase.auth.signOut() : Promise.resolve({})),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
