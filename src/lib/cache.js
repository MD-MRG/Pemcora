// The in-memory client tree, and the seam that decides where it is persisted.
//
// Why this exists at all:
//
// clientStore.js is synchronous — `listClients()` returns data, it does not
// return a promise. Every page reads during render on that assumption. Supabase
// is asynchronous, so pointing the stores straight at it would turn every read
// into a promise and ripple a refactor through all eight consumer files.
//
// So the tree is loaded once, kept in memory, and served synchronously from
// there. Writes update memory immediately — the UI never waits — and are pushed
// to the backend in the background. For one technician with a few hundred
// records, often on a bad connection, that is also simply the better behaviour.
//
// The adapter is what varies:
//
//   local     — localStorage, exactly as the app has always worked. Used by the
//               headless suites and when no session exists.
//   supabase  — the real backend, once signed in.
//
// Both implement { load(), persist(next, previous) }. `previous` is a snapshot
// taken at the last successful persist, which is what lets the Supabase adapter
// work out what actually changed rather than rewriting the whole tree.

const listeners = new Set()

const state = {
  clients: [],
  adapter: null,
  snapshot: [], // deep copy of the last state the backend is known to hold
  hydrated: false,
  status: 'idle', // 'idle' | 'loading' | 'saving' | 'saved' | 'error'
  error: null,
}

// structuredClone rather than JSON round-tripping: the tree holds Dates and
// nested objects, and JSON silently turns a Date into a string.
const clone = v => structuredClone(v)

function emit() {
  for (const fn of listeners) fn()
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const cacheStatus = () => ({
  status: state.status,
  error: state.error,
  hydrated: state.hydrated,
})

function setStatus(status, error = null) {
  state.status = status
  state.error = error
  emit()
}

/**
 * Synchronous — this is the whole point of the layer.
 *
 * Returns a copy, which is not incidental. clientStore mutates the tree in
 * place and writes it back, and callers hold pieces of it in React state. Hand
 * out the live array and a mutation is invisible to React: the reference is
 * unchanged, `Object.is` says nothing happened, and the component never
 * re-renders — the data saves correctly and the screen just does not move.
 *
 * The old implementation got this for free by parsing JSON on every read. This
 * keeps that contract, and is cheaper than the parse it replaces.
 */
export function readClients() {
  return clone(state.clients)
}

let timer = null
let inFlight = null

/**
 * Records that the tree has changed and schedules a push to the backend.
 *
 * Debounced, because clientStore writes the whole tree on every keystroke that
 * reaches it. Coalescing 600ms of edits into one push is the difference between
 * a handful of requests and hundreds while someone types a room name.
 */
export function writeClients(next) {
  if (next) state.clients = next
  emit()
  if (!state.adapter) return

  // A synchronous adapter writes through immediately. Debouncing exists to
  // coalesce network round trips, and localStorage has none to coalesce —
  // delaying it only creates a window where the stored tree disagrees with
  // memory, which is exactly what a caller reading straight back would hit.
  if (state.adapter.immediate) {
    try {
      state.adapter.persist(state.clients, state.snapshot)
      state.snapshot = clone(state.clients)
      setStatus('saved')
    } catch (e) {
      console.error('[cache] persist failed', e)
      setStatus('error', e)
    }
    return
  }

  clearTimeout(timer)
  setStatus('saving')
  timer = setTimeout(flush, 600)
}

/**
 * Pushes pending changes now and resolves when they have landed.
 *
 * Serialised through `inFlight`: two overlapping persists would diff against
 * the same snapshot and issue the same inserts twice.
 */
export async function flush() {
  clearTimeout(timer)
  if (!state.adapter) return
  if (inFlight) return inFlight

  inFlight = (async () => {
    // Captured before awaiting: edits made during the push belong to the next
    // one, and treating them as already-saved would lose them.
    const pushing = clone(state.clients)
    try {
      await state.adapter.persist(pushing, state.snapshot)
      state.snapshot = pushing
      setStatus('saved')
    } catch (e) {
      console.error('[cache] persist failed', e)
      setStatus('error', e)
      throw e
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

export const hasAdapter = () => state.adapter !== null

/**
 * Same as hydrate() for an adapter whose load is synchronous — only the local
 * one. This is what lets clientStore stay synchronous end to end in test and
 * offline mode: the very first read can fill the cache itself, with no bootstrap
 * step to forget and no window where the app renders against an empty tree.
 *
 * It refuses to run once an adapter is chosen, so it can never quietly replace
 * a signed-in user's Supabase data with whatever is in localStorage.
 */
export function hydrateSync(adapter) {
  if (state.adapter) return state.clients
  state.adapter = adapter
  state.clients = adapter.load() ?? []
  state.snapshot = clone(state.clients)
  state.hydrated = true
  return state.clients
}

/** Loads the tree from an adapter and starts serving it. */
export async function hydrate(adapter) {
  state.adapter = adapter
  setStatus('loading')
  try {
    const clients = await adapter.load()
    state.clients = clients ?? []
    state.snapshot = clone(state.clients)
    state.hydrated = true
    setStatus('idle')
  } catch (e) {
    console.error('[cache] hydrate failed', e)
    state.clients = []
    state.snapshot = []
    state.hydrated = false
    setStatus('error', e)
    throw e
  }
  emit()
  return state.clients
}

/** Drops everything held in memory — used on sign-out, so the next account
 *  cannot momentarily see the previous one's data before its own load lands. */
export function resetCache() {
  clearTimeout(timer)
  state.clients = []
  state.snapshot = []
  state.hydrated = false
  state.adapter = null
  state.status = 'idle'
  state.error = null
  emit()
}
