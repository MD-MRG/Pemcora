// The team's data, held in memory, and the seam that decides where it lives.
//
// Why this exists at all:
//
// The three stores are synchronous — `listClients()` returns data, it does not
// return a promise. Every page reads during render on that assumption. Supabase
// is asynchronous, so pointing the stores straight at it would turn every read
// into a promise and ripple a refactor through all eight consumer files.
//
// So the whole team state is loaded once, kept in memory, and served
// synchronously from there. Writes update memory immediately — the UI never
// waits — and are pushed to the backend in the background. For one technician
// with a few hundred records, often on a bad connection, that is also simply
// the better behaviour.
//
// Three slices, because they have genuinely different owners in the database:
//
//   clients    — the client → location → floor → room tree, plus visits.
//   settings   — company details, logos and brand plate (team-wide, admin-only
//                to write) plus the signed-in member's own default technician.
//   templates  — the test lists, one per workflow kind (admin-only to write).
//
// The adapter is what varies:
//
//   local     — localStorage, exactly as the app has always worked. Used by the
//               headless suites and when no session exists.
//   supabase  — the real backend, once signed in.
//
// Both implement { load(), persist(next, previous) } over all three slices at
// once. `previous` is a snapshot taken at the last successful persist, which is
// what lets the Supabase adapter work out what actually changed rather than
// rewriting everything.

const listeners = new Set()

const emptyState = () => ({
  clients: [],
  settings: null, // null means "not loaded"; the stores supply their own defaults
  templates: {},
})

const state = {
  data: emptyState(),
  adapter: null,
  snapshot: emptyState(), // what the backend is known to hold
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

export const hasAdapter = () => state.adapter !== null

/** 'local' | 'supabase' | null. Callers need this where the two genuinely
 *  differ — the localStorage quota warning has no meaning against Postgres. */
export const adapterName = () => state.adapter?.name ?? null

// ─────────────────────────────────────────────────────────────────────────────
// Reads — synchronous, which is the whole point of the layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a COPY, which is not incidental. The stores mutate their slice in
 * place and write it back, and callers hold pieces of it in React state. Hand
 * out the live object and a mutation is invisible to React: the reference is
 * unchanged, `Object.is` says nothing happened, and the component never
 * re-renders — the data saves correctly and the screen just does not move.
 *
 * The old implementations got this for free by parsing JSON on every read.
 * This keeps that contract, and is cheaper than the parse it replaces.
 */
/**
 * In local mode the store IS the source of truth, not a cache of it.
 *
 * localStorage can change under us — another tab, or a test seeding data
 * between navigations — and a hash route change does not remount the app, so a
 * value read once at boot would be served for the rest of the session. Since
 * reading it costs a JSON.parse and nothing more, local mode re-reads. That is
 * exactly what the app did before the cache existed.
 *
 * The Supabase adapter is the opposite: reading means a network round trip, so
 * its data is held and only refreshed deliberately.
 */
function current() {
  if (state.adapter?.live) {
    state.data = { ...emptyState(), ...(state.adapter.load() ?? {}) }
  }
  return state.data
}

// clone() is skipped in live mode because load() has just built these objects
// from JSON.parse — they are already nobody else's.
const take = name => (state.adapter?.live ? current()[name] : clone(state.data[name]))

export const readClients = () => take('clients')
export const readSettings = () => take('settings')
export const readTemplates = () => take('templates')

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

let timer = null
let inFlight = null

function scheduleWrite() {
  if (!state.adapter) return

  // A synchronous adapter writes through immediately. Debouncing exists to
  // coalesce network round trips, and localStorage has none to coalesce —
  // delaying it only creates a window where the stored data disagrees with
  // memory, which is exactly what a caller reading straight back would hit.
  if (state.adapter.immediate) {
    try {
      state.adapter.persist(state.data, state.snapshot)
      state.snapshot = clone(state.data)
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

// Refresh before applying, or a write to one slice persists whatever stale
// copy of the other two was in memory — silently reverting them.
function put(name, next) {
  current()
  if (next !== undefined) state.data[name] = next
  emit()
  scheduleWrite()
}

export const writeClients = next => put('clients', next)
export const writeSettings = next => put('settings', next)
export const writeTemplates = next => put('templates', next)

/**
 * Pushes pending changes now and resolves when they have landed.
 *
 * Serialised through `inFlight`: two overlapping persists would diff against
 * the same snapshot and issue the same inserts twice.
 */
export async function flush() {
  clearTimeout(timer)
  if (!state.adapter || state.adapter.immediate) return
  if (inFlight) return inFlight

  inFlight = (async () => {
    // Captured before awaiting: edits made during the push belong to the next
    // one, and treating them as already-saved would lose them.
    const pushing = clone(state.data)
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

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Same as hydrate() for an adapter whose load is synchronous — only the local
 * one. This is what lets the stores stay synchronous end to end in test and
 * offline mode: the very first read can fill the cache itself, with no bootstrap
 * step to forget and no window where the app renders against empty data.
 *
 * It refuses to run once an adapter is chosen, so it can never quietly replace
 * a signed-in user's Supabase data with whatever is in localStorage.
 */
export function hydrateSync(adapter) {
  if (state.adapter) return state.data
  state.adapter = adapter
  state.data = { ...emptyState(), ...(adapter.load() ?? {}) }
  state.snapshot = clone(state.data)
  state.hydrated = true
  return state.data
}

export async function hydrate(adapter) {
  state.adapter = adapter
  setStatus('loading')
  try {
    const loaded = await adapter.load()
    state.data = { ...emptyState(), ...(loaded ?? {}) }
    state.snapshot = clone(state.data)
    state.hydrated = true
    setStatus('idle')
  } catch (e) {
    console.error('[cache] hydrate failed', e)
    state.data = emptyState()
    state.snapshot = emptyState()
    state.hydrated = false
    setStatus('error', e)
    throw e
  }
  emit()
  return state.data
}

/** Drops everything held in memory — used on sign-out and account switches, so
 *  the next account cannot momentarily see the previous one's data. */
export function resetCache() {
  clearTimeout(timer)
  state.data = emptyState()
  state.snapshot = emptyState()
  state.hydrated = false
  state.adapter = null
  state.status = 'idle'
  state.error = null
  emit()
}
