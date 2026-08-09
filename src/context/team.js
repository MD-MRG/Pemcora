import { createContext, useContext } from 'react'

// Split from TeamProvider for the reason given in auth.js — a module that
// exports both a component and a hook loses Fast Refresh.
export const TeamContext = createContext(null)

export function useTeam() {
  const ctx = useContext(TeamContext)
  if (!ctx) throw new Error('useTeam must be used within TeamProvider')
  return ctx
}
