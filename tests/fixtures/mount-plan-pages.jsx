// Puts the upgrade sheet, the Teams page and Team Setup on the page with a signed-in
// person behind them, for tests/entitlements.mjs and tests/signup.mjs. They only do
// their real work with a session, and the suites run without one. Served by the dev
// server; nothing in src/ imports it, so it never reaches a build.
import { createRoot } from 'react-dom/client'
import { AuthContext } from '../../src/context/auth.js'
import { TeamContext } from '../../src/context/team.js'
import { visitSheet } from '../../src/lib/entitlements.js'
import StarterPackCard from '../../src/components/StarterPackCard.jsx'
import UpgradeSheet from '../../src/components/UpgradeSheet.jsx'
import Teams from '../../src/pages/Teams.jsx'
import TeamSetup from '../../src/screens/TeamSetup.jsx'

// What a new team called on the server, for the suite to read back. `answer` is what
// the next call gets: nothing, or { error: { message, code } }.
const created = (window.__created = [])
window.__answer = null

function mount(role, content, { hasTeam = true } = {}) {
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
          team: hasTeam ? team : null,
          teams: hasTeam ? [team] : [],
          role,
          isOwner: role === 'owner',
          isAdmin: role === 'owner' || role === 'admin',
          refresh: async () => {},
          createOrganisation: async details => {
            created.push(details)
            return window.__answer ?? {}
          },
          setActiveTeam: () => {},
        }}
      >
        {content}
      </TeamContext.Provider>
    </AuthContext.Provider>,
  )
}

export const mountSheet = (role, plan = null) =>
  mount(role, <UpgradeSheet sheet={visitSheet(plan, 'maintenance')} onClose={() => {}} />)

export const mountTeams = role => mount(role, <Teams />)

export const mountStarterCard = role => mount(role, <StarterPackCard />)

// With every choice open, or as the live site has them.
export const mountTeamSetup = ({ allOpen = false } = {}) =>
  mount(
    'owner',
    <TeamSetup opening={allOpen ? { pack: () => true, receiving: true } : undefined} />,
    { hasTeam: false },
  )
