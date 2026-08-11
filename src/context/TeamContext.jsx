import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from './auth.js'
import { TeamContext } from './team.js'

export function TeamProvider({ children }) {
  const { session } = useAuth()
  const [team, setTeam] = useState(null)
  const [role, setRole] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    if (!session) {
      setTeam(null)
      setRole(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('my_teams')
    if (rpcError) {
      setError(rpcError)
      setTeam(null)
      setRole(null)
    } else if (data?.length) {
      // One team per user for now, as in PM v2. my_teams already returns every
      // membership, so multi-team is a UI change here rather than a schema one.
      const t = data[0]
      setTeam({ id: t.team_id, name: t.name, inviteCode: t.invite_code })
      setRole(t.role)
    } else {
      setTeam(null)
      setRole(null)
    }
    setLoading(false)
  }, [session])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Stable identity: TeamSetup calls this from an effect, and a function
  // rebuilt on every render would make that effect's dependency list a lie.
  const createTeam = useCallback(
    async name => {
      const { data, error: e } = await supabase.rpc('create_team', { p_name: name })
      if (e) return { error: e }
      await refresh()
      return { data }
    },
    [refresh],
  )

  const value = {
    team,
    role,
    loading,
    error,
    // The owner is an admin for every purpose except granting admin, matching
    // is_team_admin() in the database so the UI and the policies agree.
    isOwner: role === 'owner',
    isAdmin: role === 'owner' || role === 'admin',
    refresh,
    createTeam,
  }
  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>
}
