import { createContext, useContext } from 'react'
import { useAuth } from './auth.js'

// Split from TeamProvider for the reason given in auth.js — a module that
// exports both a component and a hook loses Fast Refresh.
export const TeamContext = createContext(null)

export function useTeam() {
  const ctx = useContext(TeamContext)
  if (!ctx) throw new Error('useTeam must be used within TeamProvider')
  return ctx
}

/**
 * May this person delete a report record or reopen a finished visit?
 *
 * Owner and admin, per the role model. With NO session the answer is yes: that
 * is local-only mode — the headless suites, or a dev run without a backend —
 * where there is no team to be an admin of and the data belongs to this device
 * alone, so the restriction has nothing left to protect. Gating on it there
 * would only make the feature untestable.
 */
export function useCanManage() {
  const { session } = useAuth()
  const { isAdmin } = useTeam()
  return !session || isAdmin
}
