import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { prefs } from '../lib/prefs.js'
import { isNetworkFailure } from '../lib/saveErrors.js'
import { useAuth } from './auth.js'
import { TeamContext } from './team.js'

// Every request waits on the login being renewed, which on a connection going
// nowhere takes up to half a minute to fail. There is no need to sit through that
// with the last known team to hand: it takes over once the real answer arrives.
const TEAM_PATIENCE = 3000

const teamFromRow = t => ({
  id: t.team_id,
  name: t.name,
  description: t.description ?? '',
  inviteCode: t.invite_code,
  role: t.role,
  memberCount: Number(t.member_count ?? 0),
  adminCount: Number(t.admin_count ?? 0),
})

export function TeamProvider({ children }) {
  const { session } = useAuth()
  // The person, not their session. The session object changes every time the login
  // token renews, and reloading the teams then would take the app down to a spinner
  // and back, in the middle of whatever someone was doing.
  const userId = session?.user?.id ?? null
  const [teams, setTeams] = useState([])
  const [activeId, setActiveId] = useState(() => prefs.getActiveTeam())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(
    async ({ quietly = false } = {}) => {
      if (!userId) {
        setTeams([])
        setLoading(false)
        return
      }
      if (!quietly) {
        setLoading(true)
        setError(null)
      }

      // No signal is no reason to lose the team this device was working in.
      const last = prefs.getLastTeams(userId)
      const showLast = () => {
        setTeams(last)
        setError(null)
        setLoading(false)
      }
      if (navigator.onLine === false) {
        if (last) showLast()
        else if (!quietly) {
          setError({ code: '', message: 'This device is offline' })
          setLoading(false)
        }
        return
      }
      const patience = last ? setTimeout(showLast, TEAM_PATIENCE) : null

      const { data, error: rpcError } = await supabase.rpc('my_teams')
      clearTimeout(patience)
      if (rpcError) {
        if (last && isNetworkFailure(rpcError)) {
          showLast()
        } else if (!quietly) {
          setError(rpcError)
          setTeams([])
        }
      } else {
        const next = (data ?? []).map(teamFromRow)
        setTeams(next)
        setError(null)
        prefs.setLastTeams(userId, next)
      }
      setLoading(false)
    },
    [userId],
  )

  useEffect(() => {
    refresh()
  }, [refresh])

  // Back online: catch up on who is in what, without taking the app down to do it.
  useEffect(() => {
    const catchUp = () => refresh({ quietly: true })
    window.addEventListener('online', catchUp)
    return () => window.removeEventListener('online', catchUp)
  }, [refresh])

  // The stored choice is a hint, not a fact. Being moved out of a team, or
  // signing in as somebody else on a shared tablet, both leave a team id behind
  // that this account is no longer in — so it is checked against the
  // memberships every time rather than trusted.
  const team = teams.find(t => t.id === activeId) ?? teams[0] ?? null
  const role = team?.role ?? null

  const setActiveTeam = useCallback(
    id => {
      setActiveId(id)
      prefs.setActiveTeam(id)
    },
    [],
  )

  const createTeam = useCallback(
    async (name, description) => {
      const { data, error: e } = await supabase.rpc('create_team', {
        p_name: name,
        p_description: description ?? '',
      })
      if (e) return { error: e }
      await refresh()
      return { data }
    },
    [refresh],
  )

  const value = {
    team,
    teams,
    role,
    loading,
    error,
    // The owner is an admin for every purpose except granting admin, matching
    // is_team_admin() in the database so the UI and the policies agree.
    isOwner: role === 'owner',
    isAdmin: role === 'owner' || role === 'admin',
    refresh,
    createTeam,
    setActiveTeam,
  }
  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>
}
