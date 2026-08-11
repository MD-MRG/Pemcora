import {
  IconHome,
  IconClientNew,
  IconClientEdit,
  IconCommissioning,
  IconMaintenance,
  IconList,
  IconTeams,
  IconSettings,
} from './components/icons.jsx'

// Single source of truth for navigation, routes and page headings.
// `blurb` shows in the context bar under the title.
export const MAIN_NAV = [
  {
    key: 'home',
    label: 'Home',
    path: '/',
    icon: IconHome,
    blurb: 'Work in progress, anything needing attention, and your team totals',
  },
  {
    key: 'new-client',
    label: 'New Client',
    path: '/new-client',
    icon: IconClientNew,
    blurb: 'Create a client record with its sites and contacts',
  },
  {
    key: 'edit-client',
    label: 'Edit Client',
    path: '/edit-client',
    icon: IconClientEdit,
    blurb: 'Find a client and amend their details, sites and contacts',
  },
  {
    key: 'commissioning',
    label: 'Commissioning',
    path: '/commissioning',
    icon: IconCommissioning,
    blurb: 'Per-room device checks, firmware and signal verification, sign-off',
  },
  {
    key: 'maintenance',
    label: 'Preventative Maintenance',
    path: '/maintenance',
    icon: IconMaintenance,
    blurb: 'Room-by-room PM visits, faults raised, and the report that goes out',
  },
  {
    key: 'custom-list',
    label: 'Custom List',
    path: '/custom-list',
    icon: IconList,
    blurb: 'Build a one-off checklist from your own test items',
  },
  {
    key: 'teams',
    label: 'Teams',
    path: '/teams',
    icon: IconTeams,
    blurb: 'Your teams, who is in them, and who they are still waiting on',
    // Owners and admins only. SideNav filters on this; the page refuses on its
    // own account too, since a nav that merely hides a link is not a lock.
    admin: true,
  },
]

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

export const ALL_NAV = [...MAIN_NAV, ...FOOT_NAV]

export const navByPath = path =>
  ALL_NAV.find(n => n.path === path) ?? ALL_NAV.find(n => n.path === '/')
