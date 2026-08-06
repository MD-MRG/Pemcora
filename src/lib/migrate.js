// One-time import of this browser's localStorage data into the signed-in team.
//
// Both adapters implement the same interface, so the mechanics are almost
// trivial: load from the local one, persist to the Supabase one with an empty
// "previous" so everything counts as new. Everything interesting here is about
// not doing damage.
//
// Three rules this follows:
//
//   Nothing happens without being asked for. The import writes into a SHARED
//   team; a colleague's clients are not something to merge in on a hunch
//   because a browser happened to have data in it.
//
//   Nothing is deleted. localStorage is left exactly as it was, so a botched
//   import can simply be run again — and if the team turns out to be the wrong
//   one, the original is still on the device.
//
//   One bad client does not lose the other forty. Clients go up one at a time
//   and failures are collected and reported, rather than a single duplicate
//   name aborting the whole run.
//
// Note that localStorage is per-origin: data entered on the deployed site is
// not visible to a dev server, and vice versa. The import can only ever see
// what belongs to the origin it is running on.

import * as api from './api.js'
import { localAdapter } from './adapters/local.js'
import { supabaseAdapter } from './adapters/supabase.js'
import { hydrate } from './cache.js'

const IMPORTED_KEY = 'fc.imported'

/** What is sitting in this browser, without touching the cache. */
export function localSnapshot() {
  return localAdapter.load()
}

export function localSummary() {
  const { clients, settings, templates } = localSnapshot()
  let locations = 0
  let rooms = 0
  let visits = 0
  for (const c of clients ?? []) {
    for (const l of c.locations ?? []) {
      locations++
      visits += (l.visits ?? []).length
      for (const f of l.floors ?? []) rooms += (f.rooms ?? []).length
    }
  }
  return {
    clients: (clients ?? []).length,
    locations,
    rooms,
    visits,
    hasSettings: Boolean(settings && (settings.company?.name || settings.logoFull)),
    hasTemplates: Object.keys(templates ?? {}).length > 0,
    get anything() {
      return this.clients > 0 || this.hasSettings || this.hasTemplates
    },
  }
}

/** Teams already imported into from this browser, so the offer stops nagging. */
function importedTeams() {
  try {
    const raw = localStorage.getItem(IMPORTED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const alreadyImported = teamId => importedTeams().includes(teamId)

function markImported(teamId) {
  try {
    localStorage.setItem(IMPORTED_KEY, JSON.stringify([...new Set([...importedTeams(), teamId])]))
  } catch {
    /* the import still happened; we just cannot remember it */
  }
}

const EMPTY = { clients: [], settings: null, templates: {} }

// Matches the database's unique index, which is on lower(btrim(name)) — the
// comparison has to agree with it or the check passes and the insert still
// collides.
const key = name => String(name ?? '').trim().toLowerCase()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = v => typeof v === 'string' && UUID.test(v)

/**
 * Replaces any id that Postgres would refuse, keeping references consistent.
 *
 * The app has minted `crypto.randomUUID()` ids for as long as it has existed,
 * so this should be a no-op — but this is the one code path that reads data
 * written by some earlier version of the app on someone's actual laptop, and a
 * single malformed id would otherwise fail the insert with a bare 400 and take
 * that whole client with it.
 *
 * Ids are remapped, not dropped: `visit.rooms` is keyed BY room id, so minting
 * a new id for a room without rewriting that key would silently orphan every
 * result recorded against it.
 */
function withValidIds(client) {
  const remap = new Map()
  const fix = id => {
    if (isUuid(id)) return id
    if (!remap.has(id)) remap.set(id, crypto.randomUUID())
    return remap.get(id)
  }

  return {
    ...client,
    id: fix(client.id),
    locations: (client.locations ?? []).map(location => ({
      ...location,
      id: fix(location.id),
      floors: (location.floors ?? []).map(floor => ({
        ...floor,
        id: fix(floor.id),
        rooms: (floor.rooms ?? []).map(room => ({ ...room, id: fix(room.id) })),
      })),
      visits: (location.visits ?? []).map(visit => ({
        ...visit,
        id: fix(visit.id),
        rooms: Object.fromEntries(
          Object.entries(visit.rooms ?? {}).map(([roomId, entry]) => [fix(roomId), entry]),
        ),
      })),
    })),
  }
}

/**
 * Copies the selected slices into the team, then reloads the cache from the
 * backend so the app shows what actually landed rather than what was sent.
 *
 * Returns { clients: {imported, failed: [{name, reason}]}, settings, templates }.
 */
export async function importLocalData(teamId, userId, options = {}) {
  const { clients = true, settings = true, templates = true } = options
  const local = localSnapshot()
  const adapter = supabaseAdapter(teamId, userId)

  const report = {
    clients: { imported: 0, failed: [] },
    settings: 'skipped',
    templates: 'skipped',
  }

  // Settings and templates first: they are single rows, and getting them in
  // before the clients means a long client import cannot leave the team
  // half-branded if it fails partway.
  if (settings && local.settings) {
    try {
      await adapter.persist({ ...EMPTY, settings: local.settings }, EMPTY)
      report.settings = 'imported'
    } catch (e) {
      report.settings = `failed: ${e.message}`
    }
  }

  if (templates && Object.keys(local.templates ?? {}).length) {
    try {
      await adapter.persist({ ...EMPTY, templates: local.templates }, EMPTY)
      report.templates = 'imported'
    } catch (e) {
      report.templates = `failed: ${e.message}`
    }
  }

  if (clients) {
    // Ask what is already there rather than inserting and catching the
    // collision. The unique index would reject it either way, but a request
    // fired in the expectation that it fails is still a failed request: it
    // shows up as a console error and reads as a bug to whoever sees it next.
    const existing = new Set((await api.listClients(teamId)).map(c => key(c.name)))

    for (const client of local.clients ?? []) {
      if (existing.has(key(client.name))) {
        report.clients.failed.push({
          name: client.name,
          reason: 'a client with this name is already in the team',
        })
        continue
      }

      // One client per call, so one failure costs that client and no more.
      // Each carries its own locations, floors, rooms and visits.
      const prepared = withValidIds(client)
      try {
        await adapter.persist({ ...EMPTY, clients: [prepared] }, EMPTY)
        report.clients.imported++
        existing.add(key(client.name))
      } catch (e) {
        report.clients.failed.push({ name: client.name, reason: e.message })
        // The client row may already be in when a location or visit beneath it
        // fails, which would leave a client that looks imported but is missing
        // most of itself — worse than not importing it, because nothing says so.
        // Deleting cascades the partial rows away. Safe because the name check
        // above means anything we attempted here is new.
        try {
          await api.deleteClient(prepared.id)
        } catch {
          /* nothing to undo */
        }
      }
    }
  }

  markImported(teamId)

  // Re-read rather than assuming: if a client was rejected, the app must show
  // the team as it really is, not as the import hoped.
  await hydrate(supabaseAdapter(teamId, userId))
  return report
}
