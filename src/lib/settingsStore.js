// Company configuration: branding, contact details, default technician.
//
// Kept apart from prefs.js, which holds per-device preferences (nav collapse).
// Everything here now lives behind cache.js, so it persists to Supabase when
// signed in and to localStorage otherwise. The functions stay SYNCHRONOUS —
// AppShell, Settings and WorkflowPage all read during render.
//
// One thing the move made explicit. In the database these are two different
// things with two different owners:
//
//   company, logos, plate  → team_settings, shared by the whole team and
//                            writable only by an admin. They print on every
//                            report, so they describe the company, not you.
//   technician             → member_prefs, your own row. Two technicians
//                            sharing a team must not overwrite each other's
//                            name every time one of them starts a visit.
//
// The app still sees one flat settings object, because that is what the pages
// were written against; the adapter splits it on the way out.

import {
  readSettings,
  writeSettings,
  hydrateSync,
  hasAdapter,
  cacheStatus,
  adapterName,
} from './cache.js'
import { localAdapter } from './adapters/local.js'

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
  if (!hasAdapter()) hydrateSync(localAdapter)
  const stored = readSettings()
  if (stored) {
    const base = empty()
    // `company` is merged one level deeper than the rest. A spread would
    // replace it wholesale, and a fresh team's team_settings.company is `{}` —
    // so every field would come back undefined and React would warn about
    // inputs flipping from uncontrolled to controlled the moment someone typed.
    // localStorage never showed this: the app only ever wrote a complete shape.
    return { ...base, ...stored, company: { ...base.company, ...(stored.company ?? {}) } }
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

export function getSettings() {
  return read()
}

export function saveSettings(patch) {
  const next = { ...read(), ...patch }
  writeSettings(next)
  // The local adapter writes through synchronously and throws when the quota
  // refuses it, so by this line the status already tells us. The Supabase
  // adapter is debounced and will still be 'saving' — nothing has failed yet,
  // and a real failure surfaces through the cache's error state.
  const ok = cacheStatus().status !== 'error'
  return { ok, settings: next }
}

export function saveCompany(patch) {
  const current = read()
  return saveSettings({ company: { ...current.company, ...patch } })
}

// Roughly how much of the storage budget is in use, so logos can't quietly
// fill it up and start failing writes elsewhere in the app.
//
// Only meaningful on the local adapter. Signed in, the logos are jsonb columns
// in Postgres and there is no 5MB cliff to warn about, so reporting a number
// there would be inventing a limit that does not exist.
export function storageUsage() {
  if (adapterName() === 'supabase') return null
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
