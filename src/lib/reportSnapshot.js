import { MAIN, answerText, isFail, noteKey, scopeOf, typeOf } from './testTypes.js'

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
//   assets   the site's equipment as it stands today: { id, assetType, roomId,
//            label, make, model, serial, installedOn, expiresOn, removedAt,
//            attributes }

export const SNAPSHOT_VERSION = 1

const roomScoped = section => scopeOf(section) === 'room'

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

const failRows = (tests, place, group, itemId, itemLabel) =>
  tests
    .filter(t => isFail(t, (itemId ? place.results?.[group]?.[itemId] : place.results?.[group])?.[t.id]))
    .map(t => ({
      label: t.label,
      ...(itemId ? { item: itemLabel } : {}),
      note: place.troubleshooting?.[noteKey(t.id, itemId)] || '',
    }))

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
    { id: MAIN, label: template.mainLabel || 'Main test list', tests: template.tests },
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
    failed: groups.flatMap(g => failRows(g.tests, entry, g.id)),
    comments: entry.comments ?? '',
  }
}

// The items a per-item section covers: the site's items of that type, and any
// item answered during the visit that has since been removed.
function itemsFor(section, place, assets, roomNames) {
  const answered = Object.keys(place.results?.[section.id] ?? {})
  const ofType = assets.filter(
    a => a.assetType === section.assetType && (!a.removedAt || answered.includes(a.id)),
  )
  const known = new Set(ofType.map(a => a.id))
  const items = [...ofType, ...answered.filter(id => !known.has(id)).map(id => ({ id }))]
  return items.map((a, i) => ({
    id: a.id,
    label: a.label || `Item ${i + 1}`,
    room: roomNames.get(a.roomId) ?? '',
  }))
}

function siteSnapshot(site, assets, roomNames) {
  const template = site?.template
  // Whole-site sections are part of the check, so they are on unless the
  // technician switched one off.
  const sections = (template?.sections ?? []).filter(
    s => !roomScoped(s) && site.sections?.[s.id] !== false,
  )
  if (!sections.length) return null

  const failed = []
  const out = sections.map(s => {
    if (scopeOf(s) !== 'item') {
      failed.push(...failRows(s.tests, site, s.id))
      return { label: s.label, scope: 'site', tests: s.tests.map(t => answer(t, site, s.id)) }
    }
    const items = itemsFor(s, site, assets, roomNames).map(item => {
      failed.push(...failRows(s.tests, site, s.id, item.id, item.label))
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
  return {
    version: SNAPSHOT_VERSION,
    reportTitle,
    revision,
    client: client?.name ?? '',
    technician: visit?.technician ?? '',
    startedAt: visit?.startedAt ?? null,
    completedAt: visit?.completedAt ?? null,
    site: siteSnapshot(visit?.siteResults, assets, roomNames),
    rooms: rooms.map(room => roomSnapshot(room, visit?.rooms?.[room.id])),
    equipment: assets
      .filter(a => !a.removedAt)
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
