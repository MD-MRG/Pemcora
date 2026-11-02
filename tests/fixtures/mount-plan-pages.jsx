// Puts the upgrade sheet and the Teams page on the page with a signed-in team behind
// them, for tests/entitlements.mjs. Both only do their real work with a session, and
// the suites run without one. Served by the dev server; nothing in src/ imports it,
// so it never reaches a build.
import { createRoot } from 'react-dom/client'
import { AuthContext } from '../../src/context/auth.js'
import { TeamContext } from '../../src/context/team.js'
import { visitSheet } from '../../src/lib/entitlements.js'
import UpgradeSheet from '../../src/components/UpgradeSheet.jsx'
import Teams from '../../src/pages/Teams.jsx'

function mount(role, content) {
  const user = { id: 'user', email: 'sam@example.com' }
  const team = {
    id: 'team',
    name: 'Northpoint',
    description: '',
    inviteCode: 'x',
    role,
    memberCount: 3,
    adminCount: 2,
  }
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  createRoot(host).render(
    <AuthContext.Provider value={{ session: { user }, user }}>
      <TeamContext.Provider
        value={{
          team,
          teams: [team],
          role,
          isOwner: role === 'owner',
          isAdmin: role === 'owner' || role === 'admin',
          refresh: async () => {},
          createTeam: async () => ({}),
          setActiveTeam: () => {},
        }}
      >
        {content}
      </TeamContext.Provider>
    </AuthContext.Provider>,
  )
}

export const mountSheet = role =>
  mount(role, <UpgradeSheet sheet={visitSheet(null, 'maintenance')} onClose={() => {}} />)

export const mountTeams = role => mount(role, <Teams />)
