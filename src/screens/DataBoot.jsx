import { useEffect, useState } from 'react'
import { hydrate, pushStoredCopy, resetCache, flush } from '../lib/cache.js'
import { supabaseAdapter } from '../lib/adapters/supabase.js'
import { deviceCopies, removeCopy, unsavedCopies } from '../lib/offlineStore.js'
import { isNetworkFailure } from '../lib/saveErrors.js'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import Notice from '../components/Notice.jsx'
import GateLayout from './GateLayout.jsx'

// Work left on this device under another of this person's teams: they switched
// away from it with no signal. It goes when it can. Refused or failing work stays
// on the device for when that team is next open, where it can be seen and dealt with.
async function sendOtherTeams(userId, teamId) {
  const copies = (await unsavedCopies(userId)).filter(c => c.teamId !== teamId)
  for (const copy of copies) {
    try {
      const { clean, held } = await pushStoredCopy(supabaseAdapter(copy.teamId, userId), copy)
      if (clean && Object.keys(held).length === 0) await removeCopy(copy.id)
    } catch (e) {
      if (isNetworkFailure(e)) return
      console.error('[boot] could not save work from another team', e)
    }
  }
}

/**
 * Loads the team's data into the cache before the app renders.
 *
 * The app is only mounted once this has finished, which is what lets
 * clientStore stay synchronous: by the time any page reads during render, the
 * tree is already in memory. A spinner here is the price of not turning every
 * read in eight files into a promise.
 *
 * It runs on the copy kept on this device if it has to, so a load only fails with
 * no signal if this device has never had the team's data.
 */
export default function DataBoot({ children }) {
  const { user } = useAuth()
  const { team } = useTeam()
  const [state, setState] = useState('loading') // 'loading' | 'ready' | 'error'
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setState('loading')
    // Clear first: switching accounts must not show the previous team's data
    // for the moment before the new load lands.
    resetCache()
    hydrate(supabaseAdapter(team.id, user?.id), { device: deviceCopies(user?.id, team.id) })
      .then(() => {
        if (!alive) return
        setState('ready')
        sendOtherTeams(user?.id, team.id)
      })
      .catch(e => {
        if (!alive) return
        setError(e)
        setState('error')
      })
    return () => {
      alive = false
      resetCache()
    }
  }, [team.id, user?.id, attempt])

  // Pending edits are debounced, so this is the last chance to send them before
  // a close or a reload. If it doesn't finish, they are on the device already and
  // go on the next load.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  const offline = state === 'error' && isNetworkFailure(error)

  // Nothing on this device to run on, so the connection coming back is the cue.
  useEffect(() => {
    if (!offline) return undefined
    const retry = () => setAttempt(n => n + 1)
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [offline])

  if (offline) {
    return (
      <GateLayout title="No connection">
        <Notice blocked title="This device doesn't have your team's data yet">
          It needs a connection the first time. Once it has loaded here, it will open without one.
          This page will carry on by itself when the connection returns.
        </Notice>
      </GateLayout>
    )
  }

  if (state === 'error') {
    return (
      <GateLayout title="Could not load your data">
        <Notice blocked title={error?.message ?? 'Unknown error'}>
          If this mentions a missing column, the migrations in{' '}
          <code className="font-mono">supabase/migrations/</code> may not all have been run
          against this project.
        </Notice>
      </GateLayout>
    )
  }

  if (state === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-stage">
        <p className="text-[13.5px] text-ink-soft" role="status">
          Loading your data…
        </p>
      </div>
    )
  }

  return children
}
