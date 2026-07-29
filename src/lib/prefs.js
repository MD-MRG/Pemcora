// Small localStorage wrapper. Every read is guarded so private-mode or a
// cleared store degrades to defaults instead of throwing.
const KEY = {
  collapsed: 'fc.nav.collapsed',
  plate: 'fc.brand.plate',
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
}
