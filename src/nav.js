import {
  IconHome,
  IconClientNew,
  IconClientEdit,
  IconCommissioning,
  IconMaintenance,
  IconList,
  IconTeams,
  IconSettings,
  IconProperties,
  IconReports,
  IconDue,
  IconElectrical,
  IconAlarm,
} from './components/icons.jsx'
import { WORKFLOWS } from './data/packs/index.js'
import { isProvider, usesPack } from './lib/entitlements.js'

const TEAMS = {
  key: 'teams',
  label: 'Teams',
  path: '/teams',
  icon: IconTeams,
  blurb: 'Your teams, who is in them, and who they are still waiting on',
  pack: 'core',
  // Owners and admins only. SideNav filters on this; the page refuses on its
  // own account too, since a nav that merely hides a link is not a lock.
  admin: true,
}

const ICONS = {
  commissioning: IconCommissioning,
  maintenance: IconMaintenance,
  list: IconList,
  electrical: IconElectrical,
  alarm: IconAlarm,
}

// The AV pages first, in the order they have always had; then every other
// workflow in the pack registry's order.
const FIRST = ['commissioning', 'maintenance', 'custom']
const rank = w => (FIRST.includes(w.id) ? FIRST.indexOf(w.id) : FIRST.length)

// One page per workflow, from the pack registry (src/data/packs/).
export const WORKFLOW_NAV = WORKFLOWS.map((w, i) => ({ w, i }))
  .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
  .map(({ w }) => ({
    key: w.nav.key ?? w.id,
    label: w.nav.label,
    path: w.nav.path,
    icon: ICONS[w.nav.icon] ?? IconList,
    blurb: w.nav.blurb,
    workflow: w.id,
    pack: w.packId,
  }))

// Single source of truth for navigation, routes and page headings.
// `blurb` shows in the context bar under the title. `pack` is what a team has to
// hold to see the page, and a page that runs a workflow says which.
export const MAIN_NAV = [
  {
    key: 'home',
    label: 'Home',
    path: '/',
    icon: IconHome,
    blurb: 'Work in progress, anything needing attention, and your team totals',
    pack: 'core',
  },
  // A landlord's Due page is /due (RECEIVING_PAGES); an inspecting team's is
  // its own page, at its own address.
  {
    key: 'checks-due',
    label: 'Due',
    path: '/checks-due',
    icon: IconDue,
    blurb: 'Checks overdue or coming due, sites not done yet, and alarms expiring',
    pack: 'core',
  },
  {
    key: 'new-client',
    label: 'New Client',
    path: '/new-client',
    icon: IconClientNew,
    blurb: 'Create a client record with its sites and contacts',
    pack: 'core',
  },
  {
    key: 'edit-client',
    label: 'Edit Client',
    path: '/edit-client',
    icon: IconClientEdit,
    blurb: 'Find a client and amend their details, sites and contacts',
    pack: 'core',
  },
  ...WORKFLOW_NAV,
  TEAMS,
]

// Landlords and agencies receive reports rather than carry out inspections, so they
// get their own pages. A team's type is fixed when it's created (2.3).
const RECEIVING_PAGES = [
  {
    key: 'properties',
    label: 'Properties',
    path: '/properties',
    icon: IconProperties,
    blurb: 'Your properties, what is due at each one, and the reports on file',
  },
  {
    key: 'reports',
    label: 'Reports',
    path: '/reports',
    icon: IconReports,
    blurb: 'Reports your providers have sent you',
  },
  {
    key: 'due',
    label: 'Due',
    path: '/due',
    icon: IconDue,
    blurb: 'Checks that are overdue or coming up across your properties',
  },
]

export const RECEIVING_NAV = [...RECEIVING_PAGES, TEAMS]

const RECEIVING_HOME = RECEIVING_PAGES[0].path

// Pinned below a divider — utility rather than day-to-day work.
export const FOOT_NAV = [
  {
    key: 'settings',
    label: 'Settings',
    path: '/settings',
    icon: IconSettings,
    blurb: 'Branding, test lists and account preferences',
  },
]

export const ALL_NAV = [...MAIN_NAV, ...RECEIVING_PAGES, ...FOOT_NAV]

export const navByPath = path =>
  ALL_NAV.find(n => n.path === path) ?? ALL_NAV.find(n => n.path === '/')

/** The main navigation this team sees. Not knowing what it has hides nothing. */
export const navFor = entitlements =>
  isProvider(entitlements)
    ? MAIN_NAV.filter(item => usesPack(entitlements, item.pack))
    : RECEIVING_NAV

/**
 * Where an address sends this team instead, or null to open it.
 *
 * A pack's pages are hidden from a team without it, but losing an add-on must not
 * lose the work done under it (2.3): with visits of that kind on record, the page
 * opens so they can be read, and starting a new one is what gets refused.
 */
export function redirectFor(path, entitlements, hasVisitsOfKind) {
  const item = ALL_NAV.find(n => n.path === path)
  if (!entitlements || !item || item === TEAMS || FOOT_NAV.includes(item)) return null

  if (!isProvider(entitlements)) return RECEIVING_PAGES.includes(item) ? null : RECEIVING_HOME
  // A landlord's pages name no pack, so no inspecting team holds them.
  if (usesPack(entitlements, item.pack)) return null
  return item.workflow && hasVisitsOfKind(item.workflow) ? null : '/'
}
