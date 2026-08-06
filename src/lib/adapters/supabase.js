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

import * as api from '../api.js'

const byId = xs => new Map((xs ?? []).map(x => [x.id, x]))
const idsOf = xs => new Set((xs ?? []).map(x => x.id))

const changed = (a, b, keys) => keys.some(k => (a?.[k] ?? '') !== (b?.[k] ?? ''))

// Room results are free-form jsonb; comparing them field by field would mean
// re-deriving the shape here every time the workflow adds one. A structural
// compare is honest and cheap at this size.
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const LOCATION_KEYS = ['address', 'suburb', 'city', 'state', 'postcode']
const VISIT_KEYS = ['technician', 'completedAt', 'exportPreference']

export function supabaseAdapter(teamId, userId) {
  return {
    name: 'supabase',

    // Async: the cache debounces writes for this adapter rather than writing
    // through, because every one of these is a network round trip.
    immediate: false,

    async load() {
      const [clients, visits, settings, templates, prefs] = await Promise.all([
        api.listClients(teamId),
        api.listVisitsForTeam(teamId),
        api.getTeamSettings(teamId),
        api.getTemplates(teamId),
        api.getMemberPrefs(teamId, userId),
      ])

      // The database hangs visits off a location; the app expects them nested
      // inside it, keyed by room. Reshape here so nothing above this file has
      // to know the difference.
      const byLocation = new Map()
      for (const v of visits) {
        const list = byLocation.get(v.locationId) ?? []
        list.push({
          id: v.id,
          kind: v.kind,
          technician: v.technician,
          startedAt: v.startedAt,
          completedAt: v.completedAt,
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
        // yet" and fills them from testLists.js on first read.
        templates: Object.fromEntries(
          Object.entries(templates).filter(([, t]) => t && Object.keys(t).length > 0),
        ),
      }
    },

    async persist(next, previous) {
      await persistSettings(teamId, userId, next.settings, previous.settings)
      await persistTemplates(teamId, next.templates, previous.templates)
      await persistClients(teamId, userId, next.clients, previous.clients)
    },
  }
}

// Team-wide settings and the member's own technician are two different rows
// with two different owners, so they are written separately and a member who
// cannot write the first can still write the second.
async function persistSettings(teamId, userId, next, previous) {
  if (!next) return

  if (!same(next.technician, previous?.technician)) {
    await api.saveMemberPrefs(teamId, userId, {
      defaultTechnician: next.technician,
    })
  }

  const teamPatch = {}
  if (!same(next.company, previous?.company)) teamPatch.company = next.company
  if (!same(next.logoFull, previous?.logoFull)) teamPatch.logoFull = next.logoFull
  if (!same(next.logoCollapsed, previous?.logoCollapsed)) {
    teamPatch.logoCollapsed = next.logoCollapsed
  }
  if (next.plate !== previous?.plate) teamPatch.plate = next.plate
  if (Object.keys(teamPatch).length === 0) return

  // updateTeamSettings turns a zero-row update into a thrown error, which is
  // what an RLS refusal looks like on this path — a member editing branding
  // must be told, not left believing it saved.
  await api.updateTeamSettings(teamId, teamPatch)
}

async function persistTemplates(teamId, next, previous) {
  for (const [kind, template] of Object.entries(next ?? {})) {
    if (same(template, previous?.[kind])) continue
    await api.saveTemplate(teamId, kind, template)
  }
}

async function persistClients(teamId, userId, nextClients, previousClients) {
  const next = nextClients ?? []
  const previous = previousClients ?? []
  const prevClients = byId(previous)
  const nextIds = idsOf(next)

  // ── Deletes, highest level first ─────────────────────────────────────
  for (const c of previous ?? []) {
    if (!nextIds.has(c.id)) await api.deleteClient(c.id)
  }

  for (const client of next) {
    const before = prevClients.get(client.id)
    if (!before) continue // whole client is new; handled below
    const keptLocations = idsOf(client.locations)
    for (const l of before.locations ?? []) {
      if (!keptLocations.has(l.id)) await api.deleteLocation(l.id)
    }
    for (const location of client.locations) {
      const locBefore = byId(before.locations).get(location.id)
      if (!locBefore) continue
      const keptFloors = idsOf(location.floors)
      for (const f of locBefore.floors ?? []) {
        if (!keptFloors.has(f.id)) await api.deleteFloor(f.id)
      }
      const keptVisits = idsOf(location.visits)
      for (const v of locBefore.visits ?? []) {
        if (!keptVisits.has(v.id)) await api.deleteVisit(v.id)
      }
      for (const floor of location.floors ?? []) {
        const floorBefore = byId(locBefore.floors).get(floor.id)
        if (!floorBefore) continue
        const keptRooms = idsOf(floor.rooms)
        for (const r of floorBefore.rooms ?? []) {
          if (!keptRooms.has(r.id)) await api.deleteRoom(r.id)
        }
      }
      for (const visit of location.visits ?? []) {
        const visitBefore = byId(locBefore.visits).get(visit.id)
        if (!visitBefore) continue
        for (const roomId of Object.keys(visitBefore.rooms ?? {})) {
          if (!(roomId in (visit.rooms ?? {}))) {
            await api.deleteVisitRoom(visit.id, roomId)
          }
        }
      }
    }
  }

  // ── Inserts and updates ──────────────────────────────────────────────
  for (const client of next) {
    const before = prevClients.get(client.id)

    if (!before) {
      await api.createClient(teamId, client.name, client.id)
    } else if (before.name !== client.name) {
      await api.renameClient(client.id, client.name)
    }

    const locsBefore = byId(before?.locations)
    for (const location of client.locations ?? []) {
      const locBefore = locsBefore.get(location.id)

      if (!locBefore) {
        await api.addLocation(teamId, client.id, location, location.id)
      } else if (changed(locBefore, location, LOCATION_KEYS)) {
        await api.updateLocation(location.id, location)
      }

      const floorsBefore = byId(locBefore?.floors)
      for (const [i, floor] of (location.floors ?? []).entries()) {
        const floorBefore = floorsBefore.get(floor.id)
        if (!floorBefore) {
          await api.addFloor(teamId, location.id, floor, i)
        } else if (floorBefore.label !== floor.label || floorBefore.position !== i) {
          await api.updateFloor(floor.id, { label: floor.label, position: i })
        }

        const roomsBefore = byId(floorBefore?.rooms)
        for (const [j, room] of (floor.rooms ?? []).entries()) {
          const roomBefore = roomsBefore.get(room.id)
          if (!roomBefore) {
            await api.addRoom(teamId, floor.id, room, j)
          } else if (
            changed(roomBefore, room, ['name', 'planNumber']) ||
            roomBefore.position !== j
          ) {
            await api.updateRoom(room.id, { ...room, position: j })
          }
        }
      }

      const visitsBefore = byId(locBefore?.visits)
      for (const visit of location.visits ?? []) {
        const visitBefore = visitsBefore.get(visit.id)

        if (!visitBefore) {
          await api.startVisit(
            teamId,
            location.id,
            visit.kind ?? 'maintenance',
            visit.technician,
            userId,
            visit.id,
            visit.startedAt,
          )
          // A brand-new visit still needs its remaining fields; startVisit
          // only carries the ones present at creation.
          if (visit.completedAt || visit.exportPreference) {
            await api.updateVisit(visit.id, visit)
          }
        } else if (changed(visitBefore, visit, VISIT_KEYS)) {
          await api.updateVisit(visit.id, visit)
        }

        for (const [roomId, entry] of Object.entries(visit.rooms ?? {})) {
          if (same(visitBefore?.rooms?.[roomId], entry)) continue
          await api.saveVisitRoom(teamId, visit.id, roomId, {
            ...entry,
            ...roomLabels(location, roomId),
          })
        }

        const revsBefore = new Map((visitBefore?.exports ?? []).map(e => [e.revision, e]))
        for (const record of visit.exports ?? []) {
          const was = revsBefore.get(record.revision)
          if (was && was.filename === record.filename) continue
          await api.recordExport(teamId, visit.id, record.revision, record.filename, userId)
        }
      }
    }
  }
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
