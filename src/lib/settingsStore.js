// Company configuration: branding, contact details, default technician.
//
// Kept apart from prefs.js, which holds per-device preferences (nav collapse).
// Everything here describes the *company* and moves to the backend together
// when Supabase lands.

const KEY = 'fc.settings'
const LEGACY_PLATE_KEY = 'fc.brand.plate' // where the plate colour used to live

export const MAX_LOGO_BYTES = 200 * 1024

const empty = () => ({
  company: { name: '', abn: '', phone: '', email: '' },
  technician: '',
  plate: 'brass',
  logoFull: null, // { src, reportSrc, name }
  logoCollapsed: null,
})

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...empty(), ...JSON.parse(raw) }
  } catch {
    /* fall through to defaults */
  }
  // First run after the plate moved store — carry the existing choice over so
  // nobody's branding silently resets.
  const base = empty()
  try {
    const legacy = localStorage.getItem(LEGACY_PLATE_KEY)
    if (legacy) base.plate = JSON.parse(legacy)
  } catch {
    /* ignore a malformed legacy value */
  }
  return base
}

function write(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
    return true
  } catch {
    // Almost always the ~5MB quota, and almost always a logo that pushed it over.
    return false
  }
}

export function getSettings() {
  return read()
}

export function saveSettings(patch) {
  const next = { ...read(), ...patch }
  const ok = write(next)
  return { ok, settings: next }
}

export function saveCompany(patch) {
  const current = read()
  return saveSettings({ company: { ...current.company, ...patch } })
}

// Roughly how much of the storage budget is in use, so logos can't quietly
// fill it up and start failing writes elsewhere in the app.
export function storageUsage() {
  let bytes = 0
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('fc.')) bytes += (localStorage.getItem(k) ?? '').length
    }
  } catch {
    return { bytes: 0, label: 'unknown' }
  }
  const kb = bytes / 1024
  return {
    bytes,
    label: kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`,
  }
}
