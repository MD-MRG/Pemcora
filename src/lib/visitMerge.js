// Putting two versions of the same work back together.
//
// Two devices can record into one room: both joined a visit, or one was offline
// while the other carried on. M.D.'s rule is that data entered has to remain, so
// the merge goes test by test rather than room by room. If one device answered
// ten tests and the other answered nine different ones, the room ends up with all
// nineteen. Only when both changed the same test does the newest edit win.
//
// A three-way merge: `base` is what both started from, if anything, which is what
// tells "they changed it" apart from "I never touched it" and lets a cleared
// answer stay cleared. Free text is the exception. Two different comments are both
// somebody's words, so both are kept, newest first.
//
// Pure, and needs nothing but its arguments.

import { roomFails } from './testTypes.js'

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)

// jsonb hands keys back in its own order, so JSON.stringify can't compare these.
export function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (!isPlain(a) || !isPlain(b)) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (!deepEqual(a[k], b[k])) return false
  return true
}

const time = v => {
  const t = Date.parse(v ?? '')
  return Number.isNaN(t) ? 0 : t
}

const text = v => String(v ?? '').trim()

function mergeText(base, ours, theirs, oursNewer) {
  const [o, a, b] = [text(base), text(ours), text(theirs)]
  if (a === b || b === o) return ours ?? ''
  if (a === o) return theirs ?? ''
  if (!a) return theirs ?? ''
  if (!b) return ours ?? ''
  // One already holds the other: an earlier merge, or text added to it.
  if (a.includes(b)) return ours
  if (b.includes(a)) return theirs
  return oursNewer ? `${ours}\n\n${theirs}` : `${theirs}\n\n${ours}`
}

function mergeMap(base, ours, theirs, leaf) {
  const out = {}
  const keys = new Set([...Object.keys(ours ?? {}), ...Object.keys(theirs ?? {})])
  for (const key of keys) {
    const [o, a, b] = [base?.[key], ours?.[key], theirs?.[key]]
    let merged
    if (deepEqual(a, b) || deepEqual(b, o)) merged = a
    else if (deepEqual(a, o)) merged = b
    else if (isPlain(a) && isPlain(b)) merged = mergeMap(isPlain(o) ? o : {}, a, b, leaf)
    else merged = leaf(o, a, b)
    if (merged !== undefined) out[key] = merged
  }
  return out
}

const testIds = template => [
  ...(template?.tests ?? []).map(t => t.id),
  ...(template?.sections ?? []).flatMap(s => (s.tests ?? []).map(t => t.id)),
]

// The room keeps one test list, the one first opened. If the other device worked
// from a list with different tests (it was edited, or reset, in between), its
// answered tests join that list, or their answers would be kept but never shown.
function joinTemplates(kept, other, results) {
  if (!kept || !Object.keys(kept).length) return other ?? kept
  if (!other || !Object.keys(other).length || deepEqual(kept, other)) return kept

  const template = structuredClone(kept)
  template.tests = template.tests ?? []
  template.sections = template.sections ?? []
  const known = new Set(testIds(template))
  const answered = (group, t) => !known.has(t.id) && results?.[group]?.[t.id] !== undefined

  template.tests.push(...(other.tests ?? []).filter(t => answered('main', t)))
  for (const section of other.sections ?? []) {
    const missing = (section.tests ?? []).filter(t => answered(section.id, t))
    if (!missing.length) continue
    const target = template.sections.find(s => s.id === section.id)
    if (target) target.tests.push(...missing)
    else template.sections.push({ ...section, tests: missing })
  }
  return template
}

// Two devices that each filled an empty list gave the same tests different ids.
// The same label in the same section is the same test, whatever it's called
// underneath: left alone, the room would show it twice with half the answers each.
function sameTests(kept, other) {
  const map = new Map()
  const known = new Set(testIds(kept))
  const match = (keptTests, otherTests) => {
    const byLabel = new Map((keptTests ?? []).map(t => [t.label, t.id]))
    for (const t of otherTests ?? []) {
      if (!known.has(t.id) && byLabel.has(t.label)) map.set(t.id, byLabel.get(t.label))
    }
  }
  match(kept?.tests, other?.tests)
  for (const section of other?.sections ?? []) {
    const target = (kept?.sections ?? []).find(s => s.id === section.id || s.label === section.label)
    if (!target) continue
    if (target.id !== section.id) map.set(section.id, target.id)
    match(target.tests, section.tests)
  }
  return map
}

function underIds(entry, map) {
  if (!entry || !map.size) return entry
  const rename = obj =>
    Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [map.get(k) ?? k, v]))
  const groups = obj =>
    Object.fromEntries(
      Object.entries(obj ?? {}).map(([g, tests]) => [map.get(g) ?? g, isPlain(tests) ? rename(tests) : tests]),
    )
  return {
    ...entry,
    results: groups(entry.results),
    ...(entry.readings ? { readings: groups(entry.readings) } : {}),
    sections: rename(entry.sections),
    troubleshooting: rename(entry.troubleshooting),
  }
}

const hasTemplate = entry => Object.keys(entry?.template ?? {}).length > 0

/** One room. `ours` is this device's, `theirs` the database's. */
export function mergeRoom(baseEntry, oursEntry, theirs) {
  if (!theirs) return oursEntry
  if (!oursEntry) return theirs

  const ours = hasTemplate(theirs)
    ? underIds(oursEntry, sameTests(theirs.template, oursEntry.template))
    : oursEntry
  const base = hasTemplate(theirs) && hasTemplate(baseEntry)
    ? underIds(baseEntry, sameTests(theirs.template, baseEntry.template))
    : baseEntry

  const oursTime = time(ours.touchedAt)
  const theirsTime = time(theirs.touchedAt ?? theirs.updatedAt)
  const oursNewer = oursTime >= theirsTime
  const newestWins = (_o, a, b) => (oursNewer ? a : b)
  const words = (o, a, b) => mergeText(o, a, b, oursNewer)

  const results = mergeMap(base?.results, ours.results, theirs.results, newestWins)
  const merged = {
    ...ours,
    results,
    readings: mergeMap(base?.readings, ours.readings, theirs.readings, newestWins),
    sections: mergeMap(base?.sections, ours.sections, theirs.sections, newestWins),
    troubleshooting: mergeMap(base?.troubleshooting, ours.troubleshooting, theirs.troubleshooting, words),
    comments: mergeText(base?.comments, ours.comments, theirs.comments, oursNewer),
    status:
      deepEqual(ours.status, theirs.status) || deepEqual(theirs.status, base?.status)
        ? ours.status
        : deepEqual(ours.status, base?.status) || !oursNewer
          ? theirs.status
          : ours.status,
    template: joinTemplates(theirs.template, ours.template, results),
    touchedAt: oursNewer ? ours.touchedAt : (theirs.touchedAt ?? theirs.updatedAt),
  }
  if (!ours.readings && !theirs.readings) delete merged.readings
  merged.fails = roomFails(merged).length
  return merged
}

/**
 * A visit started here, and the visit already open at the site on the database.
 * The server's visit is the one that carries on: its id, its start date.
 */
export function mergeVisit(local, server) {
  const rooms = { ...(server.rooms ?? {}) }
  for (const [roomId, entry] of Object.entries(local.rooms ?? {})) {
    rooms[roomId] = mergeRoom(undefined, entry, rooms[roomId])
  }

  const exports = [...(server.exports ?? [])]
  for (const record of local.exports ?? []) {
    if (!exports.some(e => e.revision === record.revision)) exports.push(record)
  }

  return {
    ...server,
    technician: server.technician || local.technician || '',
    completedAt: server.completedAt ?? local.completedAt ?? null,
    exportPreference: server.exportPreference ?? local.exportPreference ?? null,
    rooms,
    exports: exports.sort((a, b) => a.revision - b.revision),
  }
}
