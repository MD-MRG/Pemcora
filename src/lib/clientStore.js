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

export function getLocation(clientId, locationId) {
  const client = read().find(c => c.id === clientId)
  if (!client) return null
  const location = client.locations.find(l => l.id === locationId)
  return location ? { client, location } : null
}

// Test/maintenance helper.
export function clearClients() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
