// Everything Home shows, derived from the client tree. No new storage and no
// new schema — every figure here is already implied by the visits that exist.
//
// It lives apart from Home.jsx so the rules can be read (and tested) without
// picking them out of JSX, and so the page stays presentational.

import { normalise } from './clientStore.js'
import { noteIsFinished, noteKey, roomFails, siteFails } from './testTypes.js'
import { WORKFLOWS } from '../data/packs/index.js'
import { SITE } from './siteStep.js'

// Visits stored before Commissioning existed carry no kind; they were all PM.
// Same fallback as clientStore.js — if that one changes, this must too.
const kindOf = visit => visit.kind ?? 'maintenance'

// Each workflow's name and page, from the pack registry. A kind it doesn't know
// reads as Preventative Maintenance, as a visit with none always has.
const NAV = Object.fromEntries(WORKFLOWS.map(w => [w.id, w.nav]))
export const kindLabel = kind => (NAV[kind] ?? NAV.maintenance).label
// Where a Resume lands: the workflow's route in App.jsx.
export const kindPath = kind => (NAV[kind] ?? NAV.maintenance).path

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
        kindLabel: kindLabel(kindOf(visit)),
        path: kindPath(kindOf(visit)),
        startedAt: visit.startedAt,
        days: daysSince(visit.startedAt),
        total: rooms.length,
        done: entries.filter(e => e.status === 'complete').length,
        fails:
          entries.reduce((n, e) => n + (e.fails ?? 0), 0) + siteFails(visit.siteResults).length,
      }
    })
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
}

/* ── Section 2 · what needs attention ─────────────────────────────────────── */

/**
 * FAILs that nobody has written a note against. Built on the same `roomFails`
 * as `countFails` in clientStore.js: a switched-off section keeps its results but
 * they must not raise a flag here, or the technician is chased about a section
 * they consciously excluded from the report. A suggested note still waiting for
 * its timeframe counts as unwritten.
 */
function unnotedFails(entry) {
  const notes = entry?.troubleshooting ?? {}
  return roomFails(entry).filter(f => !noteIsFinished(notes[f.testId])).length
}

// The same for a visit's whole-site step, where a test repeated per item has
// one note per item.
function unnotedSiteFails(site) {
  const notes = site?.troubleshooting ?? {}
  return siteFails(site).filter(f => !noteIsFinished(notes[noteKey(f.testId, f.itemId)])).length
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
 *   'not-saved'   a visit the database refused, sitting on this device with no
 *                 other copy anywhere. Comes first, because nobody else can see it
 *
 * Open visits are excluded from 'unexported' on purpose: an unfinished visit
 * has no report yet by definition, and it is already in section 1.
 */
export function attention(clients, held = {}) {
  const rows = []

  for (const [visitId, record] of Object.entries(held)) {
    rows.push({
      type: 'not-saved',
      key: `n-${visitId}`,
      visitId,
      clientId: record.clientId,
      clientName: record.clientName,
      locationId: record.locationId,
      where: record.where,
      kind: record.kind,
      kindLabel: kindLabel(record.kind),
      path: kindPath(record.kind),
      at: record.at,
      message: record.message,
      // Its site has been deleted, so there is no visit page left to open.
      orphan: !!record.orphan,
      action: record.orphan ? 'Discard' : 'Open visit',
    })
  }

  for (const { client, location, visit } of allVisits(clients)) {
    const base = {
      clientId: client.id,
      clientName: client.name,
      locationId: location.id,
      where: [location.address, location.suburb].filter(Boolean).join(', '),
      kind: kindOf(visit),
      kindLabel: kindLabel(kindOf(visit)),
      path: kindPath(kindOf(visit)),
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
    const siteUnnoted = visit.completedAt ? 0 : unnotedSiteFails(visit.siteResults)
    if (siteUnnoted > 0) {
      rows.push({
        ...base,
        type: 'fails',
        key: `f-${visit.id}-site`,
        // Straight to the whole-site step, where the notes go.
        roomId: SITE,
        roomName: 'Whole site',
        count: siteUnnoted,
        at: visit.siteResults.touchedAt ?? visit.startedAt,
        action: 'Open visit',
      })
    }

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

  const rank = { 'not-saved': -1, unexported: 0, fails: 1, 'no-rooms': 2 }
  return rows.sort(
    (a, b) => rank[a.type] - rank[b.type] || String(b.at ?? '').localeCompare(String(a.at ?? '')),
  )
}
