import { createContext, useContext, useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase.js'

const AuthContext = createContext(null)

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
    signUp: (email, password) =>
      supabase ? supabase.auth.signUp({ email, password }) : Promise.resolve(notConfigured),
    signOut: () => (supabase ? supabase.auth.signOut() : Promise.resolve({})),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
