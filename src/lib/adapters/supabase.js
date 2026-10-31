// Supabase persistence for all three slices of the team's data.
//
// The cache hands this adapter everything and the last version the backend is
// known to hold. Its job is to work out what actually changed and issue only
// those writes — the stores rewrite their whole slice on every edit, so pushing
// wholesale would mean rewriting every row each time somebody types.
//
// The slices land in four different places, with three different owners:
//
//   clients                → the client tree and its visits, any member's to write
//   settings.company/logo/plate → team_settings, admin-only
//   settings.technician    → member_prefs, the signed-in member's own row
//   templates              → team_templates, admin-only
//
// They are written separately and in that knowledge: a plain member editing
// their own technician name must succeed even though the same save carries
// company branding they are not allowed to touch.
//
// Two things make the client-tree diff sound:
//
//   Ids are minted client-side. clientStore already generates uuids, and every
//   insert carries its own, so a row has the same identity in memory and in
//   Postgres from the moment it exists. Without that, an insert would come back
//   with a different id and every later update would address nothing.
//
//   Deletes are issued at the highest level that changed, never per row. The
//   foreign keys cascade, so deleting a client that had four locations is one
//   request, and walking its children to delete them individually would race
//   against the cascade already doing it.
//
// Order matters: deletes, then inserts, then updates. Inserting before deleting
// can collide with a unique index that the delete was about to free — the
// one-open-visit-per-kind index especially.
//
// Two ways in, for the two jobs:
//
//   push()     the save queue (cache.js). Reports what it managed, so one thing
//              the database won't take never stops the rest from saving. A lost
//              connection is the one failure that does stop it, since nothing
//              else would get through either. Every write is safe to repeat: the
//              whole push may be sent again after an answer goes missing.
//   persist()  the import (migrate.js), which wants all of it or an error to
//              report against that client.

import * as api from '../api.js'
import { classifySaveError } from '../saveErrors.js'
import { deepEqual, mergeRoom, mergeVisit } from '../visitMerge.js'

const byId = xs => new Map((xs ?? []).map(x => [x.id, x]))
const idsOf = xs => new Set((xs ?? []).map(x => x.id))

const changed = (a, b, keys) => keys.some(k => (a?.[k] ?? '') !== (b?.[k] ?? ''))

// Room results are free-form jsonb; comparing them field by field would mean
// re-deriving the shape here every time the workflow adds one. A structural
// compare is honest and cheap at this size.
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const LOCATION_KEYS = ['address', 'suburb', 'city', 'state', 'postcode']
const VISIT_KEYS = ['technician', 'completedAt', 'exportPreference']

// What someone entered in a room, from either side. The database stores a room
// nobody has finished as in_progress, so not-started reads the same as that.
const roomContent = e => ({
  results: e?.results ?? {},
  troubleshooting: e?.troubleshooting ?? {},
  sections: e?.sections ?? {},
  comments: e?.comments ?? '',
  status: e?.status === 'complete' ? 'complete' : 'in-progress',
})
const sameRoom = (a, b) => deepEqual(roomContent(a), roomContent(b))

// The database hangs visits off a location; the app expects them nested inside
// it, keyed by room. Reshape here so nothing above this file has to know the
// difference.
const treeVisit = v => ({
  id: v.id,
  kind: v.kind,
  technician: v.technician,
  startedAt: v.startedAt,
  completedAt: v.completedAt,
  firstCompletedAt: v.firstCompletedAt,
  exportPreference: v.exportPreference,
  rooms: Object.fromEntries(
    Object.entries(v.rooms).map(([roomId, r]) => [
      roomId,
      {
        results: r.results,
        sections: r.sections,
        troubleshooting: r.troubleshooting,
        comments: r.comments,
        status: r.status,
        fails: r.fails,
        template: r.template,
        // The app orders by touchedAt to decide which room's section
        // toggles to carry forward; updated_at is the same fact.
        touchedAt: r.updatedAt,
      },
    ]),
  ),
  exports: v.exports,
})

const whereOf = location => [location.address, location.suburb].filter(Boolean).join(', ')

// Why a visit stops being sent. The database's own wording says what to do about a
// date or a plan; the other two come from something it can't see from here.
const HELD_MESSAGE = {
  gone: () => 'This visit or its site has been deleted on another device.',
  conflict: () =>
    'Another visit of this kind is open at this site. Finish that one, then try again.',
  correction: () =>
    'A correction to an earlier visit is still open at this site. Finish that first, then try again.',
  upgrade: e => e?.message ?? 'The plan refused this visit.',
  date: e => e?.message ?? 'The database refused the date on this visit.',
}

export function supabaseAdapter(teamId, userId, source = api) {
  const session = { api: source, teamId, userId }

  return {
    name: 'supabase',

    // Async: the cache debounces writes for this adapter rather than writing
    // through, because every one of these is a network round trip.
    immediate: false,

    async load() {
      const [clients, visits, settings, templates, prefs] = await Promise.all([
        source.listClients(teamId),
        source.listVisitsForTeam(teamId),
        source.getTeamSettings(teamId),
        source.getTemplates(teamId),
        source.getMemberPrefs(teamId, userId),
      ])

      const byLocation = new Map()
      for (const v of visits) {
        const list = byLocation.get(v.locationId) ?? []
        list.push(treeVisit(v))
        byLocation.set(v.locationId, list)
      }

      for (const c of clients) {
        for (const l of c.locations) {
          l.visits = byLocation.get(l.id) ?? []
        }
      }

      return {
        clients,
        // Flattened back into the one object the pages expect: the company
        // details are the team's, the technician is this member's own.
        settings: {
          company: settings.company ?? {},
          logoFull: settings.logoFull,
          logoCollapsed: settings.logoCollapsed,
          plate: settings.plate,
          technician: prefs.defaultTechnician ?? '',
        },
        // Empty rows read back as {}; templateStore treats that as "not seeded
        // yet" and fills them from the pack files on first read.
        templates: Object.fromEntries(
          Object.entries(templates).filter(([, t]) => t && Object.keys(t).length > 0),
        ),
      }
    },

    async persist(next, previous) {
      const ctx = { ...session, ...freshRun(), strict: true }
      await pushSettings(ctx, next.settings, previous.settings)
      await pushTemplates(ctx, next.templates, previous.templates)
      await pushClients(ctx, next.clients, previous.clients)
    },

    /**
     * Sends what changed, and says how it went:
     *
     *   settled         what the database now holds, the cache's next snapshot
     *   held            visits it refused: they stop being sent until retried
     *   problems        anything else it refused, tried again later
     *   unsavedClients  clients with something in that list
     *   rebase          present if a push changed the work itself: a visit joined
     *                   the one already open, or a room merged with another
     *                   device's answers. The cache runs it over its live data.
     */
    async push(next, previous, heldAlready = {}) {
      const ctx = { ...session, ...freshRun(), heldAlready }
      const settled = {
        settings: await pushSettings(ctx, next.settings, previous.settings),
        templates: await pushTemplates(ctx, next.templates, previous.templates),
        clients: await pushClients(ctx, next.clients, previous.clients),
      }
      const report = {
        settled,
        held: ctx.held,
        problems: ctx.problems,
        unsavedClients: [...new Set(ctx.unsavedClients)],
        aliases: ctx.aliases,
      }
      if (ctx.joins.length || ctx.merges.length || ctx.arrivals.length) {
        report.rebase = data => rebase(data, ctx)
      }
      return report
    },

    /**
     * Starting a visit with a connection: the visit doesn't open until the
     * database has said yes, so a refusal never gets as far as the save queue.
     */
    async startVisit(locationId, visit) {
      try {
        const row = await source.startVisit(
          teamId,
          locationId,
          visit.kind ?? 'maintenance',
          visit.technician,
          userId,
          visit.id,
          visit.startedAt,
        )
        const tree = treeVisit(row)
        if (row.id === visit.id) return { outcome: 'accepted', visit: tree }
        return { outcome: row.firstCompletedAt ? 'correction' : 'joined', visit: tree }
      } catch (e) {
        const reason = classifySaveError(e)
        if (reason === 'network') return { outcome: 'offline' }
        const message = HELD_MESSAGE[reason]?.(e) ?? e?.message ?? 'The visit could not start.'
        return { outcome: 'refused', reason, message }
      }
    },

    /**
     * What a fresh read of the database is missing that this device still holds:
     * clients that couldn't save, and refused visits. A refused visit whose site
     * has gone can't go back in the tree, so its record carries it instead.
     */
    adopt(loaded, local, held, unsavedClients) {
      // A copy: `loaded` also becomes the snapshot, which only holds what the
      // database holds.
      const data = structuredClone({ ...loaded, clients: loaded.clients ?? [] })

      for (const id of unsavedClients ?? []) {
        const mine = (local.clients ?? []).find(c => c.id === id)
        if (!mine) continue
        const at = data.clients.findIndex(c => c.id === id)
        if (at >= 0) data.clients[at] = mine
        else data.clients.push(mine)
      }

      for (const [id, record] of Object.entries(held ?? {})) {
        const visit = findVisit(local, id) ?? record.visit
        const location = findLocation(data, record.locationId)
        if (location && visit) {
          location.visits = location.visits ?? []
          const at = location.visits.findIndex(v => v.id === id)
          if (at >= 0) location.visits[at] = visit
          else location.visits.push(visit)
          delete record.visit
          delete record.orphan
        } else {
          record.visit = visit
          record.orphan = true
        }
      }
      return data
    },
  }
}

const freshRun = () => ({
  strict: false,
  heldAlready: {},
  held: {},
  problems: [],
  unsavedClients: [],
  aliases: {},
  joins: [],
  merges: [],
  arrivals: [],
})

function findLocation(data, locationId) {
  for (const client of data?.clients ?? []) {
    const location = (client.locations ?? []).find(l => l.id === locationId)
    if (location) return location
  }
  return null
}

function findVisit(data, visitId) {
  for (const client of data?.clients ?? []) {
    for (const location of client.locations ?? []) {
      const visit = (location.visits ?? []).find(v => v.id === visitId)
      if (visit) return visit
    }
  }
  return null
}

// The push saw something this device didn't have. By now the live data may have
// moved on from what was pushed, which is why this works on it afresh.
function rebase(data, ctx) {
  for (const { visit, locationId } of ctx.arrivals) {
    const location = findLocation(data, locationId)
    if (!location) continue
    location.visits = location.visits ?? []
    if (!location.visits.some(v => v.id === visit.id)) location.visits.push(structuredClone(visit))
  }

  for (const { localId, server, locationId } of ctx.joins) {
    const location = findLocation(data, locationId)
    const at = (location?.visits ?? []).findIndex(v => v.id === localId)
    if (at >= 0) location.visits[at] = mergeVisit(location.visits[at], server)
  }

  for (const { visitId, roomId, pushed, merged } of ctx.merges) {
    const visit = findVisit(data, visitId)
    if (!visit?.rooms?.[roomId]) continue
    visit.rooms[roomId] = mergeRoom(pushed, visit.rooms[roomId], merged)
  }
  return data
}

// Anything a push can carry on past. A lost connection can't be carried on past,
// and an import wants to hear about all of it.
function note(ctx, what, e) {
  if (ctx.strict || classifySaveError(e) === 'network') throw e
  console.error(`[save] ${what}`, e)
  ctx.problems.push({ what, error: e })
}

// Team-wide settings and the member's own technician are two different rows
// with two different owners, so they are written separately and a member who
// cannot write the first can still write the second.
//
// Neither is tried again if refused: a member editing branding must be told, not
// left believing it saved, but no amount of retrying will change the answer. The
// next load brings back what the database holds.
async function pushSettings(ctx, next, previous) {
  if (!next) return previous ?? next

  if (!same(next.technician, previous?.technician)) {
    try {
      await ctx.api.saveMemberPrefs(ctx.teamId, ctx.userId, {
        defaultTechnician: next.technician,
      })
    } catch (e) {
      note(ctx, 'Saving your technician name', e)
    }
  }

  const teamPatch = {}
  if (!same(next.company, previous?.company)) teamPatch.company = next.company
  if (!same(next.logoFull, previous?.logoFull)) teamPatch.logoFull = next.logoFull
  if (!same(next.logoCollapsed, previous?.logoCollapsed)) {
    teamPatch.logoCollapsed = next.logoCollapsed
  }
  if (next.plate !== previous?.plate) teamPatch.plate = next.plate
  if (Object.keys(teamPatch).length === 0) return next

  // updateTeamSettings turns a zero-row update into a thrown error, which is
  // what an RLS refusal looks like on this path — a member editing branding
  // must be told, not left believing it saved.
  try {
    await ctx.api.updateTeamSettings(ctx.teamId, teamPatch)
  } catch (e) {
    note(ctx, 'Saving the company settings', e)
  }
  return next
}

async function pushTemplates(ctx, next, previous) {
  for (const [kind, template] of Object.entries(next ?? {})) {
    if (same(template, previous?.[kind])) continue
    try {
      await ctx.api.saveTemplate(ctx.teamId, kind, template)
    } catch (e) {
      // A plain member's first read fills an empty list and is refused, as the
      // comment in templateStore.js expects. That is no failure, and it must not
      // stop their field work from saving.
      if (ctx.strict || classifySaveError(e) === 'network' || previous?.[kind]) {
        note(ctx, 'Saving a test list', e)
      }
    }
  }
  return next ?? {}
}

async function pushClients(ctx, nextClients, previousClients) {
  const next = nextClients ?? []
  const previous = previousClients ?? []
  const prevClients = byId(previous)
  const nextIds = idsOf(next)

  // ── Deletes, highest level first ─────────────────────────────────────
  for (const c of previous) {
    if (nextIds.has(c.id)) continue
    try {
      await ctx.api.deleteClient(c.id)
    } catch (e) {
      note(ctx, `Deleting ${c.name}`, e)
    }
  }

  // One client at a time, so one that won't save (its name is already taken, say)
  // doesn't hold up the rest. What it had before stays in the snapshot, so it is
  // worked out again next time.
  const settled = []
  for (const client of next) {
    const before = prevClients.get(client.id)
    try {
      settled.push(await pushClient(ctx, client, before))
    } catch (e) {
      note(ctx, `Saving ${client.name}`, e)
      ctx.unsavedClients.push(client.id)
      if (before) settled.push(before)
    }
  }
  return settled
}

async function pushClient(ctx, client, before) {
  const { api: db, teamId } = ctx

  if (before) {
    const keptLocations = idsOf(client.locations)
    for (const l of before.locations ?? []) {
      if (!keptLocations.has(l.id)) await db.deleteLocation(l.id)
    }
  }

  if (!before) {
    await db.createClient(teamId, client.name, client.id)
  } else if (before.name !== client.name) {
    await db.renameClient(client.id, client.name)
  }

  const locsBefore = byId(before?.locations)
  const locations = []
  for (const location of client.locations ?? []) {
    const locBefore = locsBefore.get(location.id)
    try {
      locations.push(await pushLocation(ctx, client, location, locBefore))
    } catch (e) {
      note(ctx, `Saving ${whereOf(location) || 'a site'}`, e)
      ctx.unsavedClients.push(client.id)
      if (locBefore) locations.push(locBefore)
    }
  }
  return { ...client, locations }
}

async function pushLocation(ctx, client, location, locBefore) {
  const { api: db, teamId } = ctx

  // ── Deletes ──────────────────────────────────────────────────────────
  if (locBefore) {
    const keptFloors = idsOf(location.floors)
    for (const f of locBefore.floors ?? []) {
      if (!keptFloors.has(f.id)) await db.deleteFloor(f.id)
    }
    const keptVisits = idsOf(location.visits)
    for (const v of locBefore.visits ?? []) {
      if (!keptVisits.has(v.id)) await db.deleteVisit(v.id)
    }
    for (const floor of location.floors ?? []) {
      const floorBefore = byId(locBefore.floors).get(floor.id)
      if (!floorBefore) continue
      const keptRooms = idsOf(floor.rooms)
      for (const r of floorBefore.rooms ?? []) {
        if (!keptRooms.has(r.id)) await db.deleteRoom(r.id)
      }
    }
    for (const visit of location.visits ?? []) {
      if (ctx.heldAlready[visit.id]) continue
      const visitBefore = byId(locBefore.visits).get(visit.id)
      if (!visitBefore) continue
      for (const roomId of Object.keys(visitBefore.rooms ?? {})) {
        if (!(roomId in (visit.rooms ?? {}))) {
          await db.deleteVisitRoom(visit.id, roomId)
        }
      }
    }
  }

  // ── Inserts and updates ──────────────────────────────────────────────
  if (!locBefore) {
    await db.addLocation(teamId, client.id, location, location.id)
  } else if (changed(locBefore, location, LOCATION_KEYS)) {
    await db.updateLocation(location.id, location)
  }

  const floorsBefore = byId(locBefore?.floors)
  for (const [i, floor] of (location.floors ?? []).entries()) {
    const floorBefore = floorsBefore.get(floor.id)
    if (!floorBefore) {
      await db.addFloor(teamId, location.id, floor, i)
    } else if (floorBefore.label !== floor.label || floorBefore.position !== i) {
      await db.updateFloor(floor.id, { label: floor.label, position: i })
    }

    const roomsBefore = byId(floorBefore?.rooms)
    for (const [j, room] of (floor.rooms ?? []).entries()) {
      const roomBefore = roomsBefore.get(room.id)
      if (!roomBefore) {
        await db.addRoom(teamId, floor.id, room, j)
      } else if (
        changed(roomBefore, room, ['name', 'planNumber']) ||
        roomBefore.position !== j
      ) {
        await db.updateRoom(room.id, { ...room, position: j })
      }
    }
  }

  // One visit at a time, so a refused one stops there. It stays on the device,
  // and whatever it was before stays in the snapshot.
  const visitsBefore = byId(locBefore?.visits)
  const visits = []
  for (const visit of location.visits ?? []) {
    const visitBefore = visitsBefore.get(visit.id)
    if (ctx.heldAlready[visit.id]) {
      if (visitBefore) visits.push(visitBefore)
      continue
    }
    try {
      visits.push(await pushVisit(ctx, client, location, visit, visitBefore))
    } catch (e) {
      const reason = classifySaveError(e)
      if (ctx.strict || reason === 'network') throw e
      if (reason === 'other') {
        note(ctx, 'Saving a visit', e)
        ctx.unsavedClients.push(client.id)
      } else {
        hold(ctx, client, location, visit, reason, e)
      }
      if (visitBefore) visits.push(visitBefore)
    }
  }
  return { ...location, visits }
}

function hold(ctx, client, location, visit, reason, error) {
  ctx.held[visit.id] = {
    reason,
    message: HELD_MESSAGE[reason](error),
    at: new Date().toISOString(),
    kind: visit.kind,
    clientId: client.id,
    clientName: client.name,
    locationId: location.id,
    where: whereOf(location),
  }
}

async function pushVisit(ctx, client, location, visit, visitBefore) {
  const { api: db, teamId, userId, strict } = ctx
  let base = visitBefore
  let brandNew = false

  if (!base) {
    const row = await db.startVisit(
      teamId,
      location.id,
      visit.kind ?? 'maintenance',
      visit.technician,
      userId,
      visit.id,
      visit.startedAt,
      // The import inserts each visit open and then completes it, so that the
      // window's rules for old work apply (see gate_visit_dates in 0006).
      strict ? undefined : visit.completedAt,
    )

    // Someone else's visit: the one already open at this site for this check.
    if (row.id !== visit.id) {
      if (strict) throw new Error('Another visit of this kind is already open at this site.')
      const server = treeVisit(row)
      // A reopened visit keeps its first completion date, so this inspection
      // would be recorded under last year's. Don't join it.
      if (server.firstCompletedAt) {
        hold(ctx, client, location, visit, 'correction')
        ctx.arrivals.push({ visit: server, locationId: location.id })
        return server
      }
      ctx.joins.push({ localId: visit.id, server, locationId: location.id })
      ctx.aliases[visit.id] = server.id
      return server
    }

    base = treeVisit(row)
    brandNew = Object.keys(base.rooms).length === 0
  }

  if (changed(base, visit, VISIT_KEYS)) await db.updateVisit(visit.id, visit)

  const settledRooms = {}
  for (const [roomId, entry] of Object.entries(visit.rooms ?? {})) {
    const roomBefore = base.rooms?.[roomId]
    if (same(roomBefore, entry)) {
      settledRooms[roomId] = entry
      continue
    }
    settledRooms[roomId] = await pushRoom(ctx, location, visit, roomId, entry, roomBefore, brandNew)
  }

  const revsBefore = new Map((base.exports ?? []).map(e => [e.revision, e]))
  for (const record of visit.exports ?? []) {
    const was = revsBefore.get(record.revision)
    if (was && was.filename === record.filename) continue
    await db.recordExport(teamId, visit.id, record.revision, record.filename, userId)
  }

  return { ...visit, rooms: settledRooms }
}

/**
 * One room. Someone else may have recorded into it since this device last read it,
 * and a save is the whole room, so saving blind would wipe their answers. So look
 * first, and if the database holds something this device hasn't seen, merge the
 * two test by test (visitMerge.js) and save that.
 */
async function pushRoom(ctx, location, visit, roomId, entry, roomBefore, brandNew) {
  const { api: db, teamId } = ctx
  let toSave = entry

  if (!ctx.strict && !brandNew) {
    const answers = await db.getVisitRoom(visit.id, roomId)
    if (answers && !sameRoom(answers, roomBefore)) {
      const server = await db.getVisitRoom(visit.id, roomId, { withTemplate: true })
      const merged = mergeRoom(roomBefore, entry, server)
      if (!sameRoom(merged, entry)) {
        toSave = merged
        ctx.merges.push({ visitId: visit.id, roomId, pushed: entry, merged })
      }
    }
  }

  const row = { ...toSave, ...roomLabels(location, roomId) }
  try {
    await db.saveVisitRoom(teamId, visit.id, roomId, row)
  } catch (e) {
    if (ctx.strict || classifySaveError(e) !== 'gone') throw e
    // The visit itself has gone, or only this room: the rest of the visit still
    // saves if it's only the room.
    if (!(await db.visitExists(visit.id))) throw e
    await db.saveRoomlessVisitRoom(teamId, visit.id, row)
  }
  return toSave
}

// visit_rooms copies the room's name, plan number and floor label beside a
// nullable room_id, so a room later deleted from a floor plan cannot blank out
// a report that was already signed off. The tree is the only place those labels
// exist at save time, so look them up here rather than trusting the entry.
function roomLabels(location, roomId) {
  for (const floor of location.floors ?? []) {
    const room = (floor.rooms ?? []).find(r => r.id === roomId)
    if (room) {
      return {
        roomName: room.name ?? '',
        planNumber: room.planNumber ?? '',
        floorLabel: floor.label ?? '',
      }
    }
  }
  return {}
}
