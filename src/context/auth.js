import { createContext, useContext } from 'react'

// The context object and its hook live here rather than beside AuthProvider, so
// that AuthContext.jsx exports a component and nothing else.
//
// React Fast Refresh gives up on any module mixing components with other
// exports: every edit to the provider forced a full reload instead of a hot
// swap, and a full reload drops the session state you were trying to look at.
// Splitting the file is the fix; a lint suppression would have left the
// behaviour exactly as broken.
export const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
