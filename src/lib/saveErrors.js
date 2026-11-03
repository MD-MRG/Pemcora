// What a failed save means, which decides what happens to the work behind it.
//
//   network   the database never answered, or answered "try again". Nothing is
//             wrong with the work: stop this push, keep everything on the device
//             and try the whole push again later.
//   upgrade   the plan refuses it (HTTP 402, hint 'upgrade', see build plan 2.11).
//   date      a date the database won't take: more than 7 days back, or a device
//             clock running fast.
//   gone      a row it depends on has been deleted, on another device say.
//   conflict  a unique index refuses it: a client of that name already exists, or
//             another visit is open at the site.
//   other     anything else. Not this work's fault as far as anyone can tell, so
//             it is shown as "Save failed" and tried again, without holding up
//             what can still save.
//
// Goes by the code and hint, never the message text. The Supabase client hands
// back a plain object with an empty code when fetch itself fails, and the first
// words of a gateway's HTML page when a proxy answers instead of the database,
// so "no code, not a thrown Error" is what a dropped connection looks like. A
// thrown Error with no code is a bug, and must not pass for a bad signal.

// Postgres gives five characters, PostgREST 'PGRST' and three digits. Anything
// else in `code` came from the network layer (ECONNRESET and so on).
const SQLSTATE = /^[0-9A-Z]{5}$/
const POSTGREST = /^PGRST\d{3}$/

// PostgREST can't reach the database (PGRST000-003), or the login token was
// refused and is about to be renewed (PGRST301-303).
const POSTGREST_RETRY = /^PGRST(00[0-3]|30[1-3])$/

// Connection (08), out of resources (53), shutting down (57), and a deadlock or
// serialization failure (40) that the next attempt won't meet.
const SQLSTATE_RETRY = /^(08|53|57|40)/

const isOurs = code => SQLSTATE.test(code) || POSTGREST.test(code)

export function classifySaveError(e) {
  const code = e?.code ?? ''

  if (code === 'VISIT_GONE' || code === '23503') return 'gone'
  if (!code || !isOurs(code)) return e instanceof Error && !code ? 'other' : 'network'

  if (POSTGREST_RETRY.test(code) || SQLSTATE_RETRY.test(code)) return 'network'
  if (code === 'PT402' || e?.hint === 'upgrade') return 'upgrade'
  if (e?.hint === 'visit_date') return 'date'
  if (code === '23505') return 'conflict'
  return 'other'
}

export const isNetworkFailure = e => classifySaveError(e) === 'network'
