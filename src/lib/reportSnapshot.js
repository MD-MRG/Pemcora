import {
  MAIN,
  answerText,
  isFail,
  noteIsFinished,
  noteKey,
  scopeOf,
  siteSections,
  typeOf,
} from './testTypes.js'

// What a report says, as plain data: the snapshot send_report() keeps with a
// delivery (build plan 2.10), and what the Excel export lays out. Building
// both from this one walk over the visit means they can never read a result
// differently.
//
// Pure — no DOM and no store, so it runs in Node as well as the browser.
//
// The database adds what can't be left to the app (the site address, the
// business name, the sign-off), so none of that is here.
//
//   rooms    the location's rooms in floor-plan order: { id, name, floorLabel,
//            planNumber }
//   assets   all the site's equipment, removed items included: { id, assetType,
//            roomId, label, make, model, serial, installedOn, expiresOn,
//            createdAt, removedAt, attributes }. The snapshot works out what
//            stood there at the visit, so a report exported later doesn't change.

export const SNAPSHOT_VERSION = 1

const roomScoped = section => scopeOf(section) === 'room'

// A check done entirely in the whole-site step: nothing to do in any room.
const isSiteOnly = template =>
  !!template?.sections?.length && !template.tests?.length && !template.sections.some(roomScoped)

const time = iso => {
  const t = Date.parse(iso ?? '')
  return Number.isNaN(t) ? null : t
}

// Was this item at the site when the visit finished? A visit still open speaks
// for now. An item with no date on record is taken to have been there.
function stoodThen(asset, visit) {
  const end = time(visit?.completedAt) ?? Infinity
  const added = time(asset.createdAt) ?? time(asset.installedOn)
  const removed = time(asset.removedAt)
  return (added === null || added <= end) && (removed === null || removed > end)
}

// One test's answer. `group` is where it is kept: results[group][testId], or
// results[group][itemId][testId] for an item.
function answer(test, place, group, itemId) {
  const at = obj => (itemId ? obj?.[group]?.[itemId] : obj?.[group])
  const value = at(place.results)?.[test.id]
  const reading = typeOf(test) === 'measure' ? at(place.readings)?.[test.id] : undefined
  const out = {
    label: test.label,
    type: typeOf(test),
    value: value ?? null,
    answer: answerText(test, value, reading),
    fail: isFail(test, value),
  }
  if (typeOf(test) === 'measure') {
    out.reading = reading?.value ?? null
    out.unit = reading?.unit ?? test.unit ?? ''
  }
  return out
}

// A fail row marks what a report has to say about it: `mustReplace` when the
// section condemns a failed item, `unfinished` when its note still holds a
// timeframe to fill in.
const failRows = (section, place, itemId, itemLabel) =>
  section.tests
    .filter(t =>
      isFail(t, (itemId ? place.results?.[section.id]?.[itemId] : place.results?.[section.id])?.[t.id]),
    )
    .map(t => {
      const note = place.troubleshooting?.[noteKey(t.id, itemId)] || ''
      return {
        label: t.label,
        ...(itemId ? { item: itemLabel } : {}),
        note,
        ...(section.onFail === 'replace' ? { mustReplace: true } : {}),
        ...(note && !noteIsFinished(note) ? { unfinished: true } : {}),
      }
    })

function roomSnapshot(room, entry) {
  const base = {
    name: room.name ?? '',
    floor: room.floorLabel ?? '',
    planNumber: room.planNumber ?? '',
  }
  const template = entry?.template
  // A room never opened has no template of its own; report it as untested
  // rather than inventing a test list for it.
  if (!template) return { ...base, tested: false }

  // Only sections switched on for this room reach the report. Whole-site and
  // per-item sections belong to the visit, not to a room.
  const visible = template.sections.filter(s => roomScoped(s) && entry.sections?.[s.id])
  const groups = [
    ...(isSiteOnly(template)
      ? []
      : [{ id: MAIN, label: template.mainLabel || 'Main test list', tests: template.tests }]),
    ...visible,
  ]
  return {
    ...base,
    tested: true,
    sections: groups.map(g => ({
      label: g.label,
      scope: 'room',
      tests: g.tests.map(t => answer(t, entry, g.id)),
    })),
    failed: groups.flatMap(g => failRows(g, entry)),
    comments: entry.comments ?? '',
  }
}

// The items a per-item section covers: the items of that type at the site when
// the visit finished, and any item answered during it. An item may hold only a
// reading, so answers are looked for in both places.
function itemsFor(section, visit, assets, roomNames) {
  const place = visit.siteResults
  const answered = new Set([
    ...Object.keys(place.results?.[section.id] ?? {}),
    ...Object.keys(place.readings?.[section.id] ?? {}),
  ])
  const ofType = assets.filter(
    a => a.assetType === section.assetType && (answered.has(a.id) || stoodThen(a, visit)),
  )
  const known = new Set(ofType.map(a => a.id))
  const items = [...ofType, ...[...answered].filter(id => !known.has(id)).map(id => ({ id }))]
  return items.map((a, i) => ({
    id: a.id,
    label: a.label || `Item ${i + 1}`,
    room: roomNames.get(a.roomId) ?? '',
  }))
}

function siteSnapshot(visit, assets, roomNames) {
  const site = visit?.siteResults
  const sections = siteSections(site)
  if (!sections.length) return null

  const failed = []
  const out = sections.map(s => {
    if (scopeOf(s) !== 'item') {
      failed.push(...failRows(s, site))
      return { label: s.label, scope: 'site', tests: s.tests.map(t => answer(t, site, s.id)) }
    }
    const items = itemsFor(s, visit, assets, roomNames).map(item => {
      failed.push(...failRows(s, site, item.id, item.label))
      return { ...item, tests: s.tests.map(t => answer(t, site, s.id, item.id)) }
    })
    return { label: s.label, scope: 'item', assetType: s.assetType, items }
  })
  return { sections: out, failed, comments: site.comments ?? '' }
}

export function buildReportSnapshot({
  client,
  visit,
  rooms = [],
  assets = [],
  revision = 1,
  reportTitle = '',
}) {
  const roomNames = new Map(rooms.map(r => [r.id, r.name ?? '']))
  // No room is opened in a whole-site check, and saying "not tested" about each
  // one would misreport a finished check.
  const siteOnly = isSiteOnly(visit?.siteResults?.template)
  return {
    version: SNAPSHOT_VERSION,
    reportTitle,
    revision,
    client: client?.name ?? '',
    technician: visit?.technician ?? '',
    startedAt: visit?.startedAt ?? null,
    completedAt: visit?.completedAt ?? null,
    site: siteSnapshot(visit, assets, roomNames),
    rooms: rooms
      .filter(room => !siteOnly || visit?.rooms?.[room.id])
      .map(room => roomSnapshot(room, visit?.rooms?.[room.id])),
    equipment: assets
      .filter(a => stoodThen(a, visit))
      .map(a => ({
        assetType: a.assetType,
        label: a.label ?? '',
        room: roomNames.get(a.roomId) ?? '',
        make: a.make ?? '',
        model: a.model ?? '',
        serial: a.serial ?? '',
        installedOn: a.installedOn ?? null,
        expiresOn: a.expiresOn ?? null,
        attributes: a.attributes ?? {},
      })),
  }
}
