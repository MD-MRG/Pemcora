import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from './AuthContext.jsx'

const TeamContext = createContext(null)

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

  const createTeam = async name => {
    const { data, error: e } = await supabase.rpc('create_team', { p_name: name })
    if (e) return { error: e }
    await refresh()
    return { data }
  }

  const joinTeam = async code => {
    const { data, error: e } = await supabase.rpc('join_team', { p_invite_code: code })
    if (e) return { error: e }
    await refresh()
    return { data }
  }

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
    joinTeam,
  }
  return <TeamContext.Provider value={value}>{children}</TeamContext.Provider>
}

export function useTeam() {
  const ctx = useContext(TeamContext)
  if (!ctx) throw new Error('useTeam must be used within TeamProvider')
  return ctx
}
