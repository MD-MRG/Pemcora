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
import { fieldText, panelTypes } from './equipment.js'
import { assetFields, assetTypeLabel } from '../data/packs/shared/assetTypes.js'

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
//   roomPhotos  each room's photos (0022), as { roomId: [{ id, category,
//            caption, takenAt }] }. Only those added by the day the visit was
//            completed reach the report (photosAtVisit), for the same reason.
//   include  which of them the report carries: 'all', 'none', 'general' or
//            'issue' (photosForChoice), as asked when the PDF is made.
//
// `equipment` is the items of the types the visit's list tests one by one: those
// standing when it finished, and those taken out during it, each with when it
// went in and came out, and what it replaced or was replaced by. An AV visit's
// list tests no items, so its report has none.

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

// Taken out while the visit was open: replaced, most likely, because it failed.
// A visit with no start on record can't say, so nothing counts.
function removedDuring(asset, visit) {
  const removed = time(asset.removedAt)
  const start = time(visit?.startedAt)
  const end = time(visit?.completedAt) ?? Infinity
  return removed !== null && start !== null && removed >= start && removed <= end
}

// What a removed item says after its name, so it isn't confused with the one put
// in its place under the same name.
const goneWord = (asset, assets) => (assets.some(a => a.attributes?.replaces === asset.id) ? 'replaced' : 'removed')

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
// test condemns its item, `unfinished` when its note still holds a timeframe to
// fill in.
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
        ...(t.onFail === 'replace' ? { mustReplace: true } : {}),
        ...(note && !noteIsFinished(note) ? { unfinished: true } : {}),
      }
    })

// The UTC day of an ISO time, as the report prints the visit's own dates.
const dayOf = iso => {
  const t = time(iso)
  return t === null ? null : new Date(t).toISOString().slice(0, 10)
}

/**
 * The room photos a report of this visit shows: those added on or before the
 * day it was completed, oldest first, so a report exported again later says
 * the same. A visit still open shows them all. Days are compared as the report
 * prints them, by the date in UTC.
 */
export function photosAtVisit(photos, visit) {
  const last = dayOf(visit?.completedAt)
  return (photos ?? [])
    .filter(p => !last || (dayOf(p.takenAt) ?? '') <= last)
    .slice()
    .sort((a, b) => (time(a.takenAt) ?? 0) - (time(b.takenAt) ?? 0))
}

/** The ways a PDF can be asked to carry room photos (M.D.). */
export const PHOTO_CHOICES = ['all', 'general', 'issue', 'none']

/**
 * The photos a report carries when it's made with `include`: 'all', 'none', or
 * one group, 'general' or 'issue'. Anything else is taken as 'all'.
 */
export function photosForChoice(photos, include = 'all') {
  if (include === 'none') return []
  if (include === 'general' || include === 'issue') return (photos ?? []).filter(p => (p.category ?? 'general') === include)
  return photos ?? []
}

function roomSnapshot(room, entry, photos) {
  const base = {
    name: room.name ?? '',
    floor: room.floorLabel ?? '',
    planNumber: room.planNumber ?? '',
    // The room's own photos (0022), in their group, described, and dated when
    // they were added. Only on a room that has some, so every other snapshot
    // reads as it did.
    ...(photos.length
      ? {
          photos: photos.map(p => ({
            id: p.id,
            category: p.category ?? 'general',
            caption: p.caption ?? '',
            addedOn: dayOf(p.takenAt) ?? '',
          })),
        }
      : {}),
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
    label: (a.label || `Item ${i + 1}`) + (a.removedAt && !stoodThen(a, visit) ? ` (${goneWord(a, assets)})` : ''),
    room: roomNames.get(a.roomId) ?? '',
  }))
}

function equipmentSnapshot(visit, assets, roomNames) {
  const types = panelTypes(visit?.siteResults?.template)
  const name = a => a.label || assetTypeLabel(a.assetType)
  const byId = new Map(assets.map(a => [a.id, a]))
  return assets
    .filter(a => types.includes(a.assetType) && (stoodThen(a, visit) || removedDuring(a, visit)))
    .sort((a, b) => types.indexOf(a.assetType) - types.indexOf(b.assetType))
    .map(a => {
      const gone = !stoodThen(a, visit)
      const replacedBy = assets.find(x => x.attributes?.replaces === a.id)
      const replaces = byId.get(a.attributes?.replaces)
      return {
        id: a.id,
        assetType: a.assetType,
        label: name(a),
        room: roomNames.get(a.roomId) ?? '',
        make: a.make ?? '',
        model: a.model ?? '',
        serial: a.serial ?? '',
        installedOn: a.installedOn ?? null,
        expiresOn: a.expiresOn ?? null,
        attributes: a.attributes ?? {},
        // The type's own fields in words, those recorded, in the pack's order.
        details: assetFields(a.assetType)
          .map(f => [f.label, fieldText(f, a.attributes?.[f.id])])
          .filter(([, text]) => text),
        createdAt: a.createdAt ?? null,
        removedAt: gone ? a.removedAt : null,
        status: !gone ? 'in place' : replacedBy ? 'replaced' : 'removed',
        replacedBy: gone && replacedBy ? name(replacedBy) : null,
        replaces: replaces ? name(replaces) : null,
      }
    })
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
  roomPhotos = {},
  include = 'all',
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
      .map(room => roomSnapshot(room, visit?.rooms?.[room.id], photosForChoice(photosAtVisit(roomPhotos[room.id], visit), include))),
    equipment: equipmentSnapshot(visit, assets, roomNames),
  }
}
