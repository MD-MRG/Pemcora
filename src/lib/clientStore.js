// Client persistence and lookup.
//
// Backed by localStorage for now. This file is the seam: when Supabase lands,
// only these internals change — the page and the duplicate logic stay put.
//
//   Client   { id, name, locations: [Location] }
//   Location { id, address, suburb, city, state, postcode, floors: [Floor] }
//   Floor    { id, label, rooms: [Room] }
//   Room     { id, name, planNumber }

const KEY = 'fc.clients'

export const uid = () => crypto.randomUUID()

// Matching ignores case and stray spacing, so "  eQuiNix " is the same client
// as "Equinix" — technicians type these by hand, twice, months apart.
export const normalise = s =>
  String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

// A location is identified by name + address + suburb. The same street number
// exists in more than one suburb, so address alone would collide wrongly.
export const locationKey = (name, address, suburb) =>
  [normalise(name), normalise(address), normalise(suburb)].join('|')

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function write(clients) {
  try {
    localStorage.setItem(KEY, JSON.stringify(clients))
  } catch {
    /* storage unavailable — the session still works, it just won't persist */
  }
}

export function listClients() {
  return read()
}

export function findClientByName(name) {
  const n = normalise(name)
  return read().find(c => normalise(c.name) === n) ?? null
}

export function findLocation(client, address, suburb) {
  if (!client) return null
  const a = normalise(address)
  const s = normalise(suburb)
  return (
    client.locations.find(l => normalise(l.address) === a && normalise(l.suburb) === s) ?? null
  )
}

const newLocation = details => ({
  id: uid(),
  address: details.address,
  suburb: details.suburb,
  city: details.city,
  state: details.state,
  postcode: details.postcode,
  floors: [],
})

/**
 * Decides what Save Client should do, and does it.
 * Returns { outcome, clientId, locationId, existing }:
 *   'created'       — brand-new client, first location
 *   'location-added'— known client, new location saved under it
 *   'duplicate'     — name + address + suburb already present; nothing written
 */
export function saveClientLocation(details) {
  const clients = read()
  const n = normalise(details.name)
  const client = clients.find(c => normalise(c.name) === n)

  if (!client) {
    const location = newLocation(details)
    const created = { id: uid(), name: details.name.trim(), locations: [location] }
    write([...clients, created])
    return { outcome: 'created', clientId: created.id, locationId: location.id }
  }

  const existing = findLocation(client, details.address, details.suburb)
  if (existing) {
    return { outcome: 'duplicate', clientId: client.id, locationId: existing.id, existing }
  }

  const location = newLocation(details)
  client.locations.push(location)
  write(clients)
  return { outcome: 'location-added', clientId: client.id, locationId: location.id }
}

const blank = s => String(s ?? '').trim() === ''

// The page always shows an empty floor and room to type into. That scaffolding
// must not reach storage, or every location acquires a phantom unnamed floor.
// A room survives if it has a name or a plan number; a floor survives if it is
// labelled or still has a room after pruning.
export function pruneFloors(floors) {
  return floors
    .map(f => ({ ...f, rooms: f.rooms.filter(r => !blank(r.name) || !blank(r.planNumber)) }))
    .filter(f => !blank(f.label) || f.rooms.length > 0)
}

// Replaces a location's floors (and their rooms) — used by autosave.
export function saveFloors(clientId, locationId, floors) {
  const clients = read()
  const client = clients.find(c => c.id === clientId)
  const location = client?.locations.find(l => l.id === locationId)
  if (!location) return false
  location.floors = pruneFloors(floors)
  write(clients)
  return true
}

/**
 * Saves edits to an existing location, and renames its client if the name
 * changed. Returns { outcome, existing?, conflictName? }:
 *   'saved'         — details written (client renamed too, if applicable)
 *   'duplicate'     — ANOTHER location of this client already has that
 *                     address + suburb; nothing written
 *   'name-conflict' — a DIFFERENT client already uses the new name; renaming
 *                     would silently merge two clients, so nothing is written
 *
 * The duplicate check deliberately skips the location being edited — otherwise
 * saving a location without touching its address matches itself and blocks.
 */
export function saveEditedLocation(clientId, locationId, details) {
  const clients = read()
  const client = clients.find(c => c.id === clientId)
  const location = client?.locations.find(l => l.id === locationId)
  if (!location) return { outcome: 'missing' }

  const newName = details.name.trim()
  if (normalise(newName) !== normalise(client.name)) {
    const clash = clients.find(c => c.id !== clientId && normalise(c.name) === normalise(newName))
    if (clash) return { outcome: 'name-conflict', conflictName: clash.name }
  }

  const a = normalise(details.address)
  const s = normalise(details.suburb)
  const twin = client.locations.find(
    l => l.id !== locationId && normalise(l.address) === a && normalise(l.suburb) === s,
  )
  if (twin) return { outcome: 'duplicate', existing: twin }

  client.name = newName
  Object.assign(location, {
    address: details.address,
    suburb: details.suburb,
    city: details.city,
    state: details.state,
    postcode: details.postcode,
  })
  write(clients)
  return { outcome: 'saved' }
}

// Adds a location to a known client, refusing an exact address + suburb twin.
export function addLocationToClient(clientId, details) {
  const clients = read()
  const client = clients.find(c => c.id === clientId)
  if (!client) return { outcome: 'missing' }

  const existing = findLocation(client, details.address, details.suburb)
  if (existing) return { outcome: 'duplicate', existing }

  const location = newLocation(details)
  client.locations.push(location)
  write(clients)
  return { outcome: 'saved', locationId: location.id }
}

// Distinct values of a location field, for the filter dropdown.
export function distinctValues(field) {
  const seen = new Map()
  for (const c of read()) {
    for (const l of c.locations) {
      const v = String(l[field] ?? '').trim()
      if (v && !seen.has(normalise(v))) seen.set(normalise(v), v)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

export function getLocation(clientId, locationId) {
  const client = read().find(c => c.id === clientId)
  if (!client) return null
  const location = client.locations.find(l => l.id === locationId)
  return location ? { client, location } : null
}

// ── Visits ──────────────────────────────────────────────────────────────────
//
// A visit is one dated session against a location for a given workflow.
// Keeping them as history is what makes "continue an unfinished one", "start a
// new one" and "revise a finished one" states of one object rather than three
// separate features.
//
//   Visit { id, kind, startedAt, completedAt|null, rooms: { [roomId]: {...} },
//           exports: [], exportPreference: null }
//
// `kind` keeps Preventative Maintenance and Commissioning apart. Without it the
// two would share a history — and worse, one workflow's Continue could open the
// other's visit and render it against the wrong test template.

export const MAINTENANCE_KIND = 'maintenance'

// Visits stored before Commissioning existed carry no kind; they were all PM.
const kindOf = visit => visit.kind ?? MAINTENANCE_KIND

const findLoc = (clients, clientId, locationId) =>
  clients.find(c => c.id === clientId)?.locations.find(l => l.id === locationId) ?? null

export function listVisits(clientId, locationId, kind = MAINTENANCE_KIND) {
  const clients = read()
  const location = findLoc(clients, clientId, locationId)
  if (!location?.visits) return []
  return location.visits
    .filter(v => kindOf(v) === kind)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))) // newest first
}

export function openVisit(clientId, locationId, kind = MAINTENANCE_KIND) {
  return listVisits(clientId, locationId, kind).find(v => !v.completedAt) ?? null
}

export function startVisit(clientId, locationId, kind = MAINTENANCE_KIND) {
  const clients = read()
  const location = findLoc(clients, clientId, locationId)
  if (!location) return null
  location.visits = location.visits ?? []

  // Only one open visit per workflow — a commissioning in progress must not
  // block a PM, and vice versa.
  const already = location.visits.find(v => !v.completedAt && kindOf(v) === kind)
  if (already) return already

  const visit = {
    id: uid(),
    kind,
    startedAt: new Date().toISOString(),
    completedAt: null,
    rooms: {},
    exports: [],
    exportPreference: null,
  }
  location.visits.push(visit)
  write(clients)
  return visit
}

export function completeVisit(clientId, locationId, visitId) {
  const clients = read()
  const location = findLoc(clients, clientId, locationId)
  const visit = location?.visits?.find(v => v.id === visitId)
  if (!visit) return false
  visit.completedAt = new Date().toISOString()
  write(clients)
  return true
}

// Every room of a location, flattened with its floor, plus this visit's status.
export function roomsWithStatus(clientId, locationId, visit) {
  const clients = read()
  const location = findLoc(clients, clientId, locationId)
  if (!location) return []
  return (location.floors ?? []).flatMap(floor =>
    floor.rooms.map(room => ({
      floorId: floor.id,
      floorLabel: floor.label,
      ...room,
      status: visit?.rooms?.[room.id]?.status ?? 'not-started',
      fails: visit?.rooms?.[room.id]?.fails ?? 0,
    })),
  )
}

/**
 * Adds a room to the LOCATION (not just the visit), so it is there next time
 * and shows up in Edit Client too. A floor is required — either an existing
 * one or a new label — so the room lands in the right part of the list.
 */
export function addRoomToLocation(clientId, locationId, { floorId, newFloorLabel, name, planNumber }) {
  const clients = read()
  const location = findLoc(clients, clientId, locationId)
  if (!location) return { outcome: 'missing' }
  location.floors = location.floors ?? []

  let floor = floorId ? location.floors.find(f => f.id === floorId) : null
  if (!floor) {
    const label = String(newFloorLabel ?? '').trim()
    if (!label) return { outcome: 'no-floor' }
    // Re-use a floor of the same name rather than creating a duplicate.
    floor = location.floors.find(f => normalise(f.label) === normalise(label))
    if (!floor) {
      floor = { id: uid(), label, rooms: [] }
      location.floors.push(floor)
    }
  }

  const room = { id: uid(), name: String(name ?? '').trim(), planNumber: String(planNumber ?? '').trim() }
  floor.rooms.push(room)
  write(clients)
  return { outcome: 'added', floorId: floor.id, roomId: room.id }
}

// ── Room entries within a visit ─────────────────────────────────────────────

const findVisit = (clients, clientId, locationId, visitId) =>
  findLoc(clients, clientId, locationId)?.visits?.find(v => v.id === visitId) ?? null

export function getRoomEntry(clientId, locationId, visitId, roomId) {
  const visit = findVisit(read(), clientId, locationId, visitId)
  return visit?.rooms?.[roomId] ?? null
}

// Which sections the most recently touched room used, so the next room starts
// configured the same way. On a 20-room site the layout is usually identical.
export function lastSectionToggles(clientId, locationId, visitId) {
  const visit = findVisit(read(), clientId, locationId, visitId)
  if (!visit?.rooms) return null
  const entries = Object.values(visit.rooms).filter(e => e?.sections && e.touchedAt)
  if (!entries.length) return null
  entries.sort((a, b) => String(b.touchedAt).localeCompare(String(a.touchedAt)))
  return entries[0].sections
}

// FAILs count only where the section is switched on — a hidden section's
// results are kept but must not reach the chip or the report.
function countFails(entry) {
  if (!entry?.results) return 0
  let n = Object.values(entry.results.main ?? {}).filter(v => v === 'FAIL').length
  for (const [sectionId, on] of Object.entries(entry.sections ?? {})) {
    if (!on) continue
    n += Object.values(entry.results[sectionId] ?? {}).filter(v => v === 'FAIL').length
  }
  return n
}

const hasAnyResult = entry =>
  Object.values(entry?.results ?? {}).some(group => Object.values(group ?? {}).some(Boolean)) ||
  String(entry?.comments ?? '').trim() !== ''

export function saveRoomEntry(clientId, locationId, visitId, roomId, patch) {
  const clients = read()
  const visit = findVisit(clients, clientId, locationId, visitId)
  if (!visit) return null
  visit.rooms = visit.rooms ?? {}

  const entry = { ...(visit.rooms[roomId] ?? {}), ...patch, touchedAt: new Date().toISOString() }
  entry.fails = countFails(entry)
  // 'complete' is only ever set by the technician; everything else is derived.
  if (entry.status !== 'complete') {
    entry.status = hasAnyResult(entry) ? 'in-progress' : 'not-started'
  }
  visit.rooms[roomId] = entry
  write(clients)
  return entry
}

// ── Report exports ──────────────────────────────────────────────────────────
//
// Only the revision record is kept, never the file. The visit holds everything
// needed to regenerate any revision, so an old one can never go stale.

export function nextRevision(visit) {
  const highest = (visit?.exports ?? []).reduce((n, e) => Math.max(n, e.revision ?? 0), 0)
  return highest + 1
}

/**
 * Records an export against a visit and closes the visit if it was still open —
 * producing the report is the point at which a PM is finished.
 *
 * mode 'revision' files it as the next revision; 'replace' re-stamps the
 * highest existing one, so the technician overwrites the file they already sent.
 */
export function recordExport(clientId, locationId, visitId, { mode, filename }) {
  const clients = read()
  const visit = findVisit(clients, clientId, locationId, visitId)
  if (!visit) return null
  visit.exports = visit.exports ?? []

  const highest = visit.exports.reduce((n, e) => Math.max(n, e.revision ?? 0), 0)
  const revision = visit.exports.length === 0 ? 1 : mode === 'replace' ? highest : highest + 1

  const record = { revision, filename, createdAt: new Date().toISOString() }
  const existing = visit.exports.findIndex(e => e.revision === revision)
  if (existing >= 0) visit.exports[existing] = record
  else visit.exports.push(record)

  if (!visit.completedAt) visit.completedAt = new Date().toISOString()

  write(clients)
  return record
}

export function setExportPreference(clientId, locationId, visitId, preference) {
  const clients = read()
  const visit = findVisit(clients, clientId, locationId, visitId)
  if (!visit) return false
  visit.exportPreference = preference
  write(clients)
  return true
}

// Test/maintenance helper.
export function clearClients() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
