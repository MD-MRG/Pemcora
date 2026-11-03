// Small localStorage wrapper. Every read is guarded so private-mode or a
// cleared store degrades to defaults instead of throwing.
const KEY = {
  collapsed: 'fc.nav.collapsed',
  plate: 'fc.brand.plate',
  activeTeam: 'fc.team.active',
  lastUser: 'fc.session.user',
  lastTeams: 'fc.session.teams',
  lastEntitlements: 'fc.session.entitlements',
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — preference simply won't persist */
  }
}

export const prefs = {
  // null means "no manual choice" — the breakpoint decides.
  getCollapsed: () => read(KEY.collapsed, null),
  setCollapsed: v => write(KEY.collapsed, v),
  getPlate: () => read(KEY.plate, null),
  setPlate: v => write(KEY.plate, v),
  // Which team this device is working in. Per device rather than per account:
  // the office machine and the van tablet are often pointed at different teams,
  // and syncing the choice would mean one of them silently changing under you.
  getActiveTeam: () => read(KEY.activeTeam, null),
  setActiveTeam: v => write(KEY.activeTeam, v),
  // Who was last signed in here and which teams they were in, to open with no
  // signal. No token: the database still decides everything once back online, and
  // this only opens what the device already holds. Cleared on signing out.
  getLastUser: () => read(KEY.lastUser, null),
  setLastUser: v => write(KEY.lastUser, v),
  getLastTeams: userId => {
    const last = read(KEY.lastTeams, null)
    return last?.userId === userId ? last.teams : null
  },
  setLastTeams: (userId, teams) => write(KEY.lastTeams, teams ? { userId, teams } : null),
  // What each of those teams had when last asked, for the same reason.
  getLastEntitlements: (userId, teamId) => {
    const last = read(KEY.lastEntitlements, null)
    return last?.userId === userId ? (last.teams[teamId] ?? null) : null
  },
  setLastEntitlements: (userId, teamId, entitlements) => {
    const last = read(KEY.lastEntitlements, null)
    const teams = last?.userId === userId ? last.teams : {}
    write(KEY.lastEntitlements, { userId, teams: { ...teams, [teamId]: entitlements } })
  },
  clearLastEntitlements: () => write(KEY.lastEntitlements, null),
}
