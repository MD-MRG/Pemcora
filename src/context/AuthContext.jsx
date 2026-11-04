import { useEffect, useRef, useState } from 'react'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { prefs } from '../lib/prefs.js'
import { forgetRenewalRefusal, loginWasEnded } from '../lib/renewal.js'
import { closeSession } from '../lib/cache.js'
import { clearCopies } from '../lib/offlineStore.js'
import {
  supabase,
  isSupabaseConfigured,
  isPasswordRecovery,
  emailRedirectUrl,
} from '../lib/supabase.js'
import { AuthContext } from './auth.js'

const notConfigured = { error: { message: 'Pemcora is not connected to a backend.' } }

// A login token lasts an hour, and renewing it takes a connection. On a site with no
// signal that is no reason to throw someone out with their work on the device, so
// the app opens as whoever was last signed in here. This is not a login. It holds
// no token and the database refuses it everything. It opens what this device already
// has, and the real session takes over as soon as the token can be renewed. If it
// can't (the login was revoked), that ends in the sign-in screen as usual.
const offlineSession = user => ({ user, offline: true })

// How long to wait to hear whether the login is still good. The library keeps
// retrying for up to half a minute on a connection that goes nowhere.
const AUTH_PATIENCE = 3000

// Who was signed in here, gone: what signing out on this device clears too.
const forgetWhoWasHere = () => {
  prefs.setLastUser(null)
  prefs.setLastTeams(null, null)
  prefs.clearLastEntitlements()
  prefs.clearLastDue()
}

// This device's login was ended from another device (build plan C5, decision
// D12). Everything the team already has goes from the device. Work that exists
// nowhere else stays, under that person, and is sent the next time they sign in
// here, as Sign out's "Keep it" does.
async function wipeEndedLogin(userId) {
  closeSession()
  if (userId) await clearCopies(userId, { keepUnsaved: true })
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  // A recovery link signs you in. That is the whole mechanism — the link IS the
  // proof — so without this flag a reset email would drop someone into the app
  // still holding the password they could not remember.
  const [recovering, setRecovering] = useState(isPasswordRecovery)
  // This device was signed out from another one: the sign-in screen says so.
  const [endedElsewhere, setEndedElsewhere] = useState(false)
  // A sign-out from this device is not one from elsewhere.
  const signingOut = useRef(false)

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false)
      return
    }

    const remembered = prefs.getLastUser()
    let heard = false
    const openFromDevice = () => {
      if (heard || !remembered) return
      setSession(offlineSession(remembered))
      setLoading(false)
    }
    if (navigator.onLine === false) openFromDevice()
    const patience = setTimeout(openFromDevice, AUTH_PATIENCE)

    supabase.auth.getSession().then(({ data, error }) => {
      heard = true
      clearTimeout(patience)
      // Couldn't reach the server to renew it isn't the same as signed out.
      if (!data.session && remembered && isAuthRetryableFetchError(error)) {
        setSession(offlineSession(remembered))
      } else {
        setSession(data.session)
      }
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      if (s?.user) {
        prefs.setLastUser({ id: s.user.id, email: s.user.email })
        if (event === 'SIGNED_IN') setEndedElsewhere(false)
      } else if (event === 'SIGNED_OUT') {
        // The library signs out by itself when a renewal is refused, whether the
        // app has just opened or has been open a while. If the Auth server said
        // this login no longer exists, it was ended elsewhere.
        const userId = prefs.getLastUser()?.id
        const ended = !signingOut.current && loginWasEnded()
        forgetWhoWasHere()
        if (ended) {
          forgetRenewalRefusal()
          setEndedElsewhere(true)
          wipeEndedLogin(userId)
        }
      } else if (event === 'INITIAL_SESSION') {
        // The library reports null here when it just couldn't reach the server.
        // getSession() above knows the difference, and decides.
        return
      }
      setSession(s)
    })

    // Back online: renew the token now rather than at the next timer tick. That
    // arrives through onAuthStateChange above.
    const renew = () => supabase.auth.getSession()
    window.addEventListener('online', renew)

    return () => {
      clearTimeout(patience)
      window.removeEventListener('online', renew)
      sub.subscription.unsubscribe()
    }
  }, [])

  const value = {
    configured: isSupabaseConfigured,
    loading,
    session,
    user: session?.user ?? null,
    recovering,
    endedElsewhere,
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
    signOut: async () => {
      if (!supabase) return {}
      // With no connection the library would spend half a minute trying to renew the
      // token, then give up before doing anything. Signing out has to work regardless:
      // the stored login goes, and the token runs out by itself.
      const reachable = navigator.onLine !== false && !session?.offline
      signingOut.current = true
      try {
        // This device only. Left to itself the library ends the login on every
        // device, which signs the same person out of a phone mid-visit.
        const result = reachable ? await supabase.auth.signOut({ scope: 'local' }) : { error: null }
        if (!reachable || result.error) localStorage.removeItem(supabase.auth.storageKey)
        forgetWhoWasHere()
        setSession(null)
        return result
      } finally {
        signingOut.current = false
      }
    },
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
