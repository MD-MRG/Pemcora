// localStorage persistence — what the app has always done.
//
// Still the adapter in two cases: the headless suites (which seed and assert
// against `fc.clients` directly), and any run without a session. Keeping it as
// a real adapter rather than a special case in the cache means the local path
// and the Supabase path are the same code everywhere above this file.

const KEY = 'fc.clients'

export const localAdapter = {
  // Written through on every change rather than debounced: there is no network
  // round trip to coalesce, and a delay would let the stored tree lag memory.
  immediate: true,

  load() {
    try {
      const raw = localStorage.getItem(KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  },

  persist(clients) {
    try {
      localStorage.setItem(KEY, JSON.stringify(clients))
    } catch {
      // Almost always the ~5MB quota. The session keeps working from memory;
      // it just will not survive a reload.
    }
  },

  clear() {
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* nothing to clear */
    }
  },
}
