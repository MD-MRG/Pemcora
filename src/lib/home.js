// Everything Home shows, derived from the client tree. No new storage and no
// new schema — every figure here is already implied by the visits that exist.
//
// It lives apart from Home.jsx so the rules can be read (and tested) without
// picking them out of JSX, and so the page stays presentational.

import { normalise } from './clientStore.js'

// Visits stored before Commissioning existed carry no kind; they were all PM.
// Same fallback as clientStore.js — if that one changes, this must too.
const kindOf = visit => visit.kind ?? 'maintenance'

export const KIND_LABEL = {
  maintenance: 'Preventative Maintenance',
  commissioning: 'Commissioning',
  custom: 'Custom List',
}

// Where a Resume lands. Mirrors the routes in App.jsx.
export const KIND_PATH = {
  maintenance: '/maintenance',
  commissioning: '/commissioning',
  custom: '/custom-list',
}

const allVisits = clients =>
  clients.flatMap(client =>
    client.locations.flatMap(location =>
      (location.visits ?? []).map(visit => ({ client, location, visit })),
    ),
  )

const roomsOf = location => (location.floors ?? []).flatMap(f => f.rooms ?? [])

const exportCount = visit => (visit.exports ?? []).length

/* ── The four figures ─────────────────────────────────────────────────────── */

/**
 * Clients count by distinct name, locations by distinct address + suburb +
 * city, so the same site entered twice is one site. Reports count export
 * RECORDS, not export presses: `recordExport` keeps one record per revision and
 * re-stamps it on a replace, so this is "how many report files exist", which is
 * what someone means by "reports generated".
 */
export function stats(clients) {
  const names = new Set()
  const sites = new Set()
  let pmReports = 0
  let commissioningReports = 0

  for (const client of clients) {
    names.add(normalise(client.name))
    for (const location of client.locations) {
      sites.add(
        [normalise(location.address), normalise(location.suburb), normalise(location.city)].join('|'),
      )
      for (const visit of location.visits ?? []) {
        const kind = kindOf(visit)
        if (kind === 'maintenance') pmReports += exportCount(visit)
        else if (kind === 'commissioning') commissioningReports += exportCount(visit)
      }
    }
  }

  return { clients: names.size, locations: sites.size, pmReports, commissioningReports }
}

/* ── Section 1 · what is in progress ──────────────────────────────────────── */

const DAY = 86400000
const daysSince = iso => Math.floor((Date.now() - new Date(iso).getTime()) / DAY)

/**
 * Every open visit across every client and workflow, newest first — the answer
 * to "what was I doing?". Room totals come from the location's floor plan and
 * the per-room entries the visit recorded.
 */
export function openWork(clients) {
  return allVisits(clients)
    .filter(({ visit }) => !visit.completedAt)
    .map(({ client, location, visit }) => {
      const rooms = roomsOf(location)
      const entries = rooms.map(r => visit.rooms?.[r.id]).filter(Boolean)
      return {
        key: visit.id,
        clientId: client.id,
        clientName: client.name,
        locationId: location.id,
        where: [location.address, location.suburb].filter(Boolean).join(', '),
        kind: kindOf(visit),
        kindLabel: KIND_LABEL[kindOf(visit)] ?? KIND_LABEL.maintenance,
        path: KIND_PATH[kindOf(visit)] ?? KIND_PATH.maintenance,
        startedAt: visit.startedAt,
        days: daysSince(visit.startedAt),
        total: rooms.length,
        done: entries.filter(e => e.status === 'complete').length,
        fails: entries.reduce((n, e) => n + (e.fails ?? 0), 0),
      }
    })
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
}

/* ── Section 2 · what needs attention ─────────────────────────────────────── */

/**
 * FAILs that nobody has written a note against. Deliberately mirrors
 * `countFails` in clientStore.js: a switched-off section keeps its results but
 * they must not raise a flag here, or the technician is chased about a section
 * they consciously excluded from the report.
 */
function unnotedFails(entry) {
  if (!entry?.results) return 0
  const notes = entry.troubleshooting ?? {}
  const bare = id => String(notes[id] ?? '').trim() === ''
  const count = group =>
    Object.entries(group ?? {}).filter(([id, v]) => v === 'FAIL' && bare(id)).length

  let n = count(entry.results.main)
  for (const [sectionId, on] of Object.entries(entry.sections ?? {})) {
    if (on) n += count(entry.results[sectionId])
  }
  return n
}

/**
 * The things section 1 does NOT already show, ranked by who is waiting:
 *
 *   'unexported'  a visit is finished but no report was ever produced — the
 *                 client is waiting on something the app already holds
 *   'fails'       FAILs recorded with no troubleshooting note — the report
 *                 will go out saying a test failed and nothing about why
 *   'no-rooms'    a location with no floor plan — every workflow dead-ends
 *                 there until rooms exist
 *
 * Open visits are excluded from 'unexported' on purpose: an unfinished visit
 * has no report yet by definition, and it is already in section 1.
 */
export function attention(clients) {
  const rows = []

  for (const { client, location, visit } of allVisits(clients)) {
    const base = {
      clientId: client.id,
      clientName: client.name,
      locationId: location.id,
      where: [location.address, location.suburb].filter(Boolean).join(', '),
      kind: kindOf(visit),
      kindLabel: KIND_LABEL[kindOf(visit)] ?? KIND_LABEL.maintenance,
      path: KIND_PATH[kindOf(visit)] ?? KIND_PATH.maintenance,
    }

    if (visit.completedAt && exportCount(visit) === 0) {
      rows.push({
        ...base,
        type: 'unexported',
        key: `x-${visit.id}`,
        at: visit.completedAt,
        action: 'Export',
      })
    }

    // Only an OPEN visit. A finished visit's rooms are read-only, so flagging a
    // missing note there sends the technician to a screen that cannot take one —
    // the note has to be written before the visit is finished or not at all.
    for (const room of visit.completedAt ? [] : roomsOf(location)) {
      const n = unnotedFails(visit.rooms?.[room.id])
      if (n > 0) {
        rows.push({
          ...base,
          type: 'fails',
          key: `f-${visit.id}-${room.id}`,
          roomId: room.id,
          roomName: room.name || 'Unnamed room',
          count: n,
          at: visit.rooms[room.id].touchedAt,
          action: 'Open room',
        })
      }
    }
  }

  for (const client of clients) {
    for (const location of client.locations) {
      if (roomsOf(location).length === 0) {
        rows.push({
          type: 'no-rooms',
          key: `r-${location.id}`,
          clientId: client.id,
          clientName: client.name,
          locationId: location.id,
          where: [location.address, location.suburb].filter(Boolean).join(', '),
          action: 'Add rooms',
        })
      }
    }
  }

  const rank = { unexported: 0, fails: 1, 'no-rooms': 2 }
  return rows.sort(
    (a, b) => rank[a.type] - rank[b.type] || String(b.at ?? '').localeCompare(String(a.at ?? '')),
  )
}
