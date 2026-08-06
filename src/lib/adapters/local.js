// localStorage persistence — what the app has always done.
//
// Still the adapter in two cases: the headless suites (which seed and assert
// against these exact keys), and any run without a session. Keeping it as a
// real adapter rather than a special case in the cache means the local path and
// the Supabase path are the same code everywhere above this file.
//
// The key names are load-bearing. Ten suites read and write them directly, and
// so does anyone whose data predates the backend.

const KEYS = {
  clients: 'fc.clients',
  settings: 'fc.settings',
  templates: 'fc.templates',
}

const readKey = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

export const localAdapter = {
  name: 'local',

  // Reads go to localStorage every time rather than being cached in memory.
  // A hash route change does not remount the app, so anything read once at boot
  // would be served for the rest of the session — including an empty store read
  // before a test seeded it. Parsing is the entire cost, and it is what the app
  // did before the cache existed.
  live: true,

  // Written through on every change rather than debounced: there is no network
  // round trip to coalesce, and a delay would let the stored data lag memory.
  immediate: true,

  load() {
    const clients = readKey(KEYS.clients, [])
    return {
      clients: Array.isArray(clients) ? clients : [],
      // null, not {}: the stores tell "never saved" from "saved as empty" and
      // apply their own defaults for the former.
      settings: readKey(KEYS.settings, null),
      templates: readKey(KEYS.templates, {}),
    }
  },

  // Throws when a write is refused rather than swallowing it, so the cache
  // records an error and Settings can still say "storage is full" instead of a
  // save that quietly did nothing. That message is the only warning anyone gets
  // before a logo starts costing them their job data.
  persist(data) {
    const results = [
      write(KEYS.clients, data.clients ?? []),
      data.settings === null ? true : write(KEYS.settings, data.settings),
      write(KEYS.templates, data.templates ?? {}),
    ]
    if (results.some(ok => !ok)) throw new Error('Local storage is full.')
  },

  clear() {
    for (const key of Object.values(KEYS)) {
      try {
        localStorage.removeItem(key)
      } catch {
        /* nothing to clear */
      }
    }
  },
}

// Returns false when the write is refused — almost always the ~5MB quota, and
// almost always a logo that pushed it over.
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}
