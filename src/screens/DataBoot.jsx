import { useEffect, useState } from 'react'
import { hydrate, resetCache, flush } from '../lib/cache.js'
import { supabaseAdapter } from '../lib/adapters/supabase.js'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import Notice from '../components/Notice.jsx'
import GateLayout from './GateLayout.jsx'

/**
 * Loads the team's data into the cache before the app renders.
 *
 * The app is only mounted once this has finished, which is what lets
 * clientStore stay synchronous: by the time any page reads during render, the
 * tree is already in memory. A spinner here is the price of not turning every
 * read in eight files into a promise.
 */
export default function DataBoot({ children }) {
  const { user } = useAuth()
  const { team } = useTeam()
  const [state, setState] = useState('loading') // 'loading' | 'ready' | 'error'
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setState('loading')
    // Clear first: switching accounts must not show the previous team's data
    // for the moment before the new load lands.
    resetCache()
    hydrate(supabaseAdapter(team.id, user?.id))
      .then(() => alive && setState('ready'))
      .catch(e => {
        if (!alive) return
        setError(e)
        setState('error')
      })
    return () => {
      alive = false
    }
  }, [team.id, user?.id])

  // Pending edits are debounced, so a close or reload within that window would
  // drop them. This is best-effort — the browser gives no guarantee an async
  // call started here completes — but it costs nothing and catches the common
  // case of someone closing the tab straight after typing.
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
