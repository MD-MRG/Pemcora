import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { prefs } from '../lib/prefs.js'
import { useAuth } from './auth.js'
import { TeamContext } from './team.js'

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
  const [teams, setTeams] = useState([])
  const [activeId, setActiveId] = useState(() => prefs.getActiveTeam())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!session) {
      setTeams([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('my_teams')
    if (rpcError) {
      setError(rpcError)
      setTeams([])
    } else {
      setTeams((data ?? []).map(teamFromRow))
    }
    setLoading(false)
  }, [session])

  useEffect(() => {
    refresh()
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
