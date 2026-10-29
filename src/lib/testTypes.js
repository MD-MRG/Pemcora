// What a test or section in a template can be, and how its answers are kept.
//
// Templates written before the editions build have no `type` or `scope`
// anywhere, so every default below is today's behaviour: a test is a
// PASS/FAIL/N/A check and a section belongs to each room.
//
// Tests (`test.type`):
//
//   check    PASS / FAIL / NA                     results[group][testId]
//   choice   the chosen option's text             results[group][testId]
//   yesno    YES / NO / NA — a NO is a fail       results[group][testId]
//   measure  { value, unit }                      readings[group][testId]
//            and, when the test sets min or max,
//            PASS / FAIL (or NA)                  results[group][testId]
//   text     what the technician typed            results[group][testId]
//
// A fail takes a troubleshooting note, whatever the type. The note box can
// offer the template's `failNotes`: suggested wording the technician picks and
// then edits, such as an electrician's defect classifications.
//
// Sections (`section.scope`):
//
//   room     once in every room, switched on per room (the default)
//   site     once per visit, in visits.site_results
//   item     once for every item of `assetType` at the site, in
//            visits.site_results, each item's answers under its id:
//            results[sectionId][itemId][testId]
//
// A room section can name `roomTypes` that switch it on by themselves, and a
// template can carry `coverage` rules such as "every bedroom has a smoke
// alarm": { roomTypes: ['bedroom'], assetType: 'smoke_alarm', min: 1 }.
//
// The group a room's main list answers under is 'main'.

export const TEST_TYPES = ['check', 'choice', 'yesno', 'measure', 'text']
export const SCOPES = ['room', 'site', 'item']
export const MAIN = 'main'

export const typeOf = test => test?.type ?? 'check'
export const scopeOf = section => section?.scope ?? 'room'

// A test the template no longer knows is read as a check, which is what every
// result was before tests had types.
export function isFail(test, value) {
  switch (typeOf(test)) {
    case 'yesno':
      return value === 'NO'
    case 'choice':
    case 'text':
      return false
    default:
      return value === 'FAIL'
  }
}

// PASS or FAIL for a reading against the test's limits; undefined when the
// test has none or there is no number to judge.
export function measureResult(test, value) {
  if (test?.min == null && test?.max == null) return undefined
  if (value === '' || value == null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return (test.min != null && n < test.min) || (test.max != null && n > test.max) ? 'FAIL' : 'PASS'
}

// Troubleshooting notes are keyed by test id, as they always were. A test
// repeated for each item needs one note per item.
export const noteKey = (testId, itemId) => (itemId ? `${itemId}:${testId}` : testId)

const RESULT_TEXT = { PASS: 'PASS', FAIL: 'FAIL', NA: 'N/A' }
const YESNO_TEXT = { YES: 'Yes', NO: 'No', NA: 'N/A' }

// The answer as a report prints it. Blank stays blank — a test left
// unanswered is not "not applicable".
export function answerText(test, value, reading) {
  switch (typeOf(test)) {
    case 'yesno':
      return value ? (YESNO_TEXT[value] ?? value) : ''
    case 'choice':
    case 'text':
      return value ?? ''
    case 'measure': {
      if (value === 'NA') return 'N/A'
      const shown =
        reading?.value === '' || reading?.value == null
          ? ''
          : `${reading.value} ${reading.unit ?? test.unit ?? ''}`.trim()
      const verdict = value === 'PASS' || value === 'FAIL' ? value : ''
      return [shown, verdict].filter(Boolean).join(' — ')
    }
    default:
      return value ? (RESULT_TEXT[value] ?? value) : ''
  }
}

// 'pass', 'fail', 'na' or '' — how a report colours the answer.
export function answerTone(test, value) {
  if (isFail(test, value)) return 'fail'
  if (value === 'NA') return 'na'
  if (value === 'PASS' || (typeOf(test) === 'yesno' && value === 'YES')) return 'pass'
  return ''
}

const testsById = template =>
  new Map(
    [...(template?.tests ?? []), ...(template?.sections ?? []).flatMap(s => s.tests ?? [])].map(t => [
      t.id,
      t,
    ]),
  )

// A room's fails, from its main list and the sections switched on in it — a
// switched-off section keeps its results but they reach neither the chip nor
// the report. Each fail is { testId, value }.
export function roomFails(entry) {
  if (!entry?.results) return []
  const byId = testsById(entry.template)
  const fails = group =>
    Object.entries(group ?? {})
      .filter(([id, v]) => isFail(byId.get(id), v))
      .map(([testId, value]) => ({ testId, value }))
  const out = fails(entry.results[MAIN])
  for (const [sectionId, on] of Object.entries(entry.sections ?? {})) {
    if (on) out.push(...fails(entry.results[sectionId]))
  }
  return out
}

// The room sections a room of this type switches on by itself.
export function sectionsForRoomType(template, roomType) {
  if (!roomType) return {}
  return Object.fromEntries(
    (template?.sections ?? [])
      .filter(s => scopeOf(s) === 'room' && s.roomTypes?.includes(roomType))
      .map(s => [s.id, true]),
  )
}

// Rooms that break a coverage rule: a bedroom with no smoke alarm in it.
// `rooms` are { id, name, roomType }; `assets` are { id, assetType, roomId,
// removedAt }. Each gap is { rule, room, found }.
export function coverageGaps(template, rooms, assets) {
  const gaps = []
  for (const rule of template?.coverage ?? []) {
    for (const room of rooms ?? []) {
      if (!rule.roomTypes?.includes(room.roomType)) continue
      const found = (assets ?? []).filter(
        a => !a.removedAt && a.assetType === rule.assetType && a.roomId === room.id,
      ).length
      if (found < (rule.min ?? 1)) gaps.push({ rule, room, found })
    }
  }
  return gaps
}
