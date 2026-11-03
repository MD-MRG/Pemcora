/**
 * Template types — what step B2 adds to a test list, held to the rules in
 * src/lib/testTypes.js.
 *
 * Not a browser suite: it imports the helpers, templateStore.js, the snapshot
 * and the Excel export straight into Node, with an in-memory localStorage
 * standing in for the browser's. Nothing in the app shows a typed list until
 * step C1, so this is where they are proved.
 *
 *   - each answer type: what it keeps, when it is a fail, how a report prints it
 *   - a template using every type and scope round-trips through the store
 *   - fails, room-type sections and coverage gaps
 *   - the report snapshot and the Excel export, for a whole-site visit with
 *     items, readings and notes — and for an AV visit, exactly as before
 */
import ExcelJS from 'exceljs'

const log = (k, v, extra = '') =>
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const store = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
})

const types = await import('../src/lib/testTypes.js')
const { isFail, measureResult, answerText, answerTone, noteKey, noteIsFinished, roomFails, siteFails, sectionsForRoomType, coverageGaps } = types
const { getTemplate, saveTemplate } = await import('../src/lib/templateStore.js')
const { saveRoomEntry } = await import('../src/lib/clientStore.js')
const { attention, openWork } = await import('../src/lib/home.js')
const { buildReportSnapshot } = await import('../src/lib/reportSnapshot.js')
const { buildWorkbook } = await import('../src/lib/report.js')
const { workflow, pageConfig } = await import('../src/data/packs/index.js')

// ── Each type ────────────────────────────────────────────────────────────────
const check = { id: 'c', label: 'Check' }
const yesno = { id: 'y', label: 'Yes or no', type: 'yesno' }
const choice = { id: 'h', label: 'Choice', type: 'choice', options: ['Checked', 'Not applicable', 'Not included'] }
const measure = { id: 'm', label: 'Trip time', type: 'measure', unit: 'ms', max: 300 }
const reading = { id: 'r', label: 'Earth', type: 'measure', unit: 'Ω' }
const text = { id: 't', label: 'Notes', type: 'text' }

log('a test with no type is a PASS/FAIL/N/A check',
  types.typeOf({ label: 'x' }) === 'check' && isFail(check, 'FAIL') && !isFail(check, 'PASS') && !isFail(check, 'NA'))
log('a No is a fail; a Yes or N/A is not',
  isFail(yesno, 'NO') && !isFail(yesno, 'YES') && !isFail(yesno, 'NA'))
log('a choice or text answer is never a fail',
  !isFail(choice, 'Not included') && !isFail(text, 'FAIL'))
log('a reading fails only outside its limits',
  measureResult(measure, '24') === 'PASS' && measureResult(measure, 301) === 'FAIL' &&
  measureResult({ ...measure, min: 10, max: undefined }, 9) === 'FAIL' &&
  measureResult(reading, '0.1') === undefined && measureResult(measure, '') === undefined &&
  measureResult(measure, 'abc') === undefined)
log('a blank reading is not judged as a reading of zero',
  measureResult(measure, '   ') === undefined && measureResult({ ...measure, min: 10 }, '   ') === undefined &&
  answerText(reading, undefined, { value: '   ', unit: 'Ω' }) === '')
log('a reading of zero still is one',
  measureResult({ ...measure, min: 10 }, 0) === 'FAIL' && answerText(reading, undefined, { value: 0, unit: 'Ω' }) === '0 Ω')
log('a judged reading fails like a check', isFail(measure, 'FAIL') && !isFail(measure, 'PASS'))
log('a test the template no longer knows is read as a check',
  isFail(undefined, 'FAIL') && !isFail(undefined, 'NO'))
log('answers print by type',
  answerText(check, 'NA') === 'N/A' && answerText(check, undefined) === '' &&
  answerText(yesno, 'NO') === 'No' && answerText(yesno, 'YES') === 'Yes' &&
  answerText(choice, 'Not included') === 'Not included' && answerText(text, 'Line 1') === 'Line 1' &&
  answerText(measure, 'PASS', { value: 24, unit: 'ms' }) === '24 ms — PASS' &&
  answerText(reading, undefined, { value: '0.12', unit: 'Ω' }) === '0.12 Ω' &&
  answerText(reading, 'NA', { value: '' }) === 'N/A' && answerText(reading, undefined, undefined) === '',
  [answerText(measure, 'PASS', { value: 24, unit: 'ms' }), answerText(reading, undefined, { value: '0.12', unit: 'Ω' })].join(' | '))
log('answers are coloured by what they mean',
  answerTone(yesno, 'NO') === 'fail' && answerTone(yesno, 'YES') === 'pass' &&
  answerTone(check, 'NA') === 'na' && answerTone(choice, 'Checked') === '' && answerTone(measure, 'FAIL') === 'fail')
log('words typed or chosen never take a result colour',
  answerTone(text, 'PASS') === '' && answerTone(text, 'NA') === '' && answerTone(choice, 'NA') === '' &&
  answerTone(choice, 'PASS') === '' && answerTone(measure, 'PASS') === 'pass' && answerTone(yesno, 'NA') === 'na')
log('an item\'s note is kept apart from the same test on another item',
  noteKey('t1') === 't1' && noteKey('t1', 'a1') === 'a1:t1' && noteKey('t1', 'a1') !== noteKey('t1', 'a2'))
log('a note waiting for its timeframe is not finished',
  noteIsFinished('Replaced') && !noteIsFinished('') && !noteIsFinished('   ') && !noteIsFinished(undefined) &&
  !noteIsFinished('Repair recommended within [timeframe].') && noteIsFinished('Repair recommended within 6 months.'))

// ── Round trip through the store ─────────────────────────────────────────────
const everything = {
  mainLabel: 'Main test list',
  tests: [
    { id: 't1', label: 'Check', order: 0 },
    { id: 't2', label: 'Yes or no', order: 1, type: 'yesno' },
    { id: 't3', label: 'Choice', order: 2, type: 'choice', options: ['Checked', 'Not applicable', 'Not included'] },
    { id: 't4', label: 'Reading', order: 3, type: 'measure', unit: 'ms', min: 0, max: 300 },
    { id: 't5', label: 'Text', order: 4, type: 'text' },
  ],
  sections: [
    { id: 's1', label: 'Bedroom', order: 0, roomTypes: ['bedroom', 'hallway'], tests: [{ id: 't6', label: 'Alarm sounds', order: 0 }] },
    { id: 's2', label: 'Switchboard', order: 1, scope: 'site', tests: [{ id: 't7', label: 'Earth', order: 0, type: 'measure', unit: 'Ω' }] },
    { id: 's3', label: 'Each RCD', order: 2, scope: 'item', assetType: 'rcd', tests: [{ id: 't8', label: 'Push-button test', order: 0 }] },
  ],
  coverage: [{ roomTypes: ['bedroom'], assetType: 'smoke_alarm', min: 1 }],
  failNotes: ['Fail – does not comply. Repair or replacement is mandatory.'],
}
saveTemplate('custom', structuredClone(everything))
const stored = JSON.parse(store.get('fc.templates')).custom
log('a template using every type and scope is stored as it was given', same(stored, everything))
log('and reads back the same', same(getTemplate('custom'), everything))

const elec = getTemplate('electrical_safety')
log('the electrical checks seed their fail-note suggestions',
  elec.failNotes?.length === 3 && same(getTemplate('vic_electrical_safety').failNotes, elec.failNotes) &&
  /\[timeframe\]/.test(elec.failNotes[1]) && !getTemplate('maintenance').failNotes,
  elec.failNotes?.join(' | '))

// ── Fails, room types and coverage ───────────────────────────────────────────
const avEntry = {
  results: { main: { a: 'FAIL', b: 'PASS' }, s1: { c: 'FAIL' }, s2: { d: 'FAIL' } },
  sections: { s1: true, s2: false },
}
log('an AV room with no template counts FAILs as before, hidden sections excluded',
  roomFails(avEntry).map(f => f.testId).join() === 'a,c')
const typedEntry = {
  template: everything,
  results: { main: { t1: 'PASS', t2: 'NO', t3: 'Not included', t4: 'FAIL', t5: 'FAIL' }, s1: { t6: 'FAIL' } },
  sections: { s1: false },
}
log('a typed room counts a No and a failed reading, not a choice or text',
  roomFails(typedEntry).map(f => f.testId).join() === 't2,t4', roomFails(typedEntry).map(f => f.testId).join())

log('a room type switches on its sections',
  same(sectionsForRoomType(everything, 'hallway'), { s1: true }) &&
  same(sectionsForRoomType(everything, 'kitchen'), {}) && same(sectionsForRoomType(everything, ''), {}))

const houseRooms = [
  { id: 'b1', name: 'Bedroom 1', roomType: 'bedroom' },
  { id: 'b2', name: 'Bedroom 2', roomType: 'bedroom' },
  { id: 'b3', name: 'Bedroom 3', roomType: 'bedroom' },
  { id: 'k', name: 'Kitchen', roomType: 'kitchen' },
]
const houseAssets = [
  { id: 'x1', assetType: 'smoke_alarm', roomId: 'b1' },
  { id: 'x2', assetType: 'smoke_alarm', roomId: 'b2', removedAt: '2026-10-01' },
  { id: 'x3', assetType: 'rcd', roomId: 'b3' },
]
const gaps = coverageGaps(workflow('qld_smoke_alarm').seed, houseRooms, houseAssets)
log('coverage finds the bedrooms with no working alarm',
  gaps.map(g => g.room.name).join() === 'Bedroom 2,Bedroom 3' && gaps.every(g => g.found === 0),
  gaps.map(g => g.room.name).join())
log('a list with no coverage rules has no gaps', coverageGaps(getTemplate('maintenance'), houseRooms, []).length === 0)

// ── A whole-site visit: the snapshot ─────────────────────────────────────────
// The Victorian electrical check, as the store seeds it, with answers in every
// type of section.
const vic = getTemplate('vic_electrical_safety')
const sec = n => vic.sections[n]
const tid = (n, i) => sec(n).tests[i].id
const rcds = [
  { id: 'rcd1', assetType: 'rcd', label: 'RCD 1 — lights', roomId: 'garage' },
  { id: 'rcd2', assetType: 'rcd', label: 'RCD 2 — power', removedAt: '2026-10-28', roomId: null },
  { id: 'rcd3', assetType: 'rcd', label: 'RCD 3 — spare', removedAt: '2026-01-01' },
  { id: 'al1', assetType: 'smoke_alarm', label: 'Hall alarm' },
]
const siteVisit = {
  technician: 'Sam',
  startedAt: '2026-10-28T23:00:00Z',
  completedAt: '2026-10-29T03:00:00Z',
  siteResults: {
    template: vic,
    sections: { [sec(6).id]: true },
    results: {
      [sec(0).id]: { [tid(0, 0)]: 'Included', [tid(0, 15)]: 'Not included' },
      [sec(1).id]: { [tid(1, 0)]: 'Checked' },
      [sec(4).id]: {
        rcd1: { [tid(4, 0)]: 'Lights, ground floor', [tid(4, 1)]: 'PASS', [tid(4, 2)]: 'PASS', [tid(4, 3)]: 'PASS' },
        rcd2: { [tid(4, 1)]: 'FAIL' },
      },
      [sec(5).id]: { [tid(5, 0)]: 'NO' },
      [sec(6).id]: { [tid(6, 0)]: 'Replaced cracked socket-outlet in the laundry' },
    },
    readings: {
      [sec(3).id]: { [tid(3, 0)]: { value: '0.12', unit: 'Ω' } },
      [sec(4).id]: { rcd1: { [tid(4, 3)]: { value: 24, unit: 'ms' } } },
    },
    troubleshooting: {
      [noteKey(tid(4, 1), 'rcd2')]: vic.failNotes[0],
      [tid(5, 0)]: 'Hall alarm missing',
    },
    comments: 'Switchboard labels faded.',
  },
  rooms: {},
}
const siteRooms = [{ id: 'garage', name: 'Garage', floorLabel: 'Ground' }]
const snap = buildReportSnapshot({ client: { name: 'Rental Co' }, visit: siteVisit, rooms: siteRooms, assets: rcds, revision: 2, reportTitle: 'Electrical Safety Check' })

log('the snapshot is plain data', same(JSON.parse(JSON.stringify(snap)), snap))
log('it carries the client, technician, dates and revision',
  snap.client === 'Rental Co' && snap.technician === 'Sam' && snap.revision === 2 &&
  snap.startedAt === siteVisit.startedAt && snap.completedAt === siteVisit.completedAt && snap.version === 1)
log('every whole-site section is in it, in order',
  snap.site?.sections.map(s => s.label.split('.')[0]).join() === 'B,C,D1,D2,D3,E,F')
const s = n => snap.site.sections[n]
log('a choice keeps the option chosen', s(0).tests[0].answer === 'Included' && s(0).tests[15].answer === 'Not included' && s(0).tests[1].answer === '')
log('a reading keeps its value and unit',
  s(3).tests[0].reading === '0.12' && s(3).tests[0].unit === 'Ω' && s(3).tests[0].answer === '0.12 Ω' &&
  s(3).tests[1].reading === null && s(3).tests[1].unit === 'Ω')
log('per-item sections list the site\'s items, and a removed one answered that day',
  s(4).scope === 'item' && s(4).items.map(i => i.id).join() === 'rcd1,rcd2' &&
  s(4).items[0].room === 'Garage' && s(4).items[0].label === 'RCD 1 — lights',
  s(4).items?.map(i => i.id).join())
log('each item keeps its own answers',
  s(4).items[0].tests.map(t => t.answer).join('|') === 'Lights, ground floor|PASS|PASS|24 ms — PASS' &&
  s(4).items[1].tests.map(t => t.answer).join('|') === '|FAIL||',
  s(4).items.map(i => i.tests.map(t => t.answer).join('|')).join(' / '))
log('a No and a failed item test are the visit\'s fails, with their notes',
  same(snap.site.failed, [
    { label: 'Push-button test', item: 'RCD 2 — power', note: vic.failNotes[0] },
    { label: sec(5).tests[0].label, note: 'Hall alarm missing' },
  ]), JSON.stringify(snap.site.failed))
log('text answers and comments come through',
  s(6).tests[0].answer === 'Replaced cracked socket-outlet in the laundry' && snap.site.comments === 'Switchboard labels faded.')
log('the equipment list leaves out removed items',
  snap.equipment.map(e => e.label).join() === 'RCD 1 — lights,Hall alarm' && snap.equipment[0].room === 'Garage')
log('a room opened on a whole-site check reports no empty list and none of its sections',
  buildReportSnapshot({ visit: { rooms: { garage: { template: vic, sections: { [sec(0).id]: true } } } }, rooms: siteRooms })
    .rooms[0].sections.length === 0)

const offVisit = structuredClone(siteVisit)
offVisit.siteResults.sections = { [sec(6).id]: false }
log('a whole-site section switched off stays out',
  buildReportSnapshot({ visit: offVisit, rooms: siteRooms, assets: rcds }).site.sections.length === 6)
log('an AV visit has no whole-site part',
  buildReportSnapshot({ visit: { rooms: {} }, rooms: [] }).site === null)

// Rooms on a check done in the whole-site step.
log('a whole-site check does not call its rooms untested',
  snap.rooms.length === 0, JSON.stringify(snap.rooms))
const mixed = {
  mainLabel: 'Main test list',
  tests: [{ id: 'mt', label: 'Room check', order: 0 }],
  sections: [{ id: 'ms', label: 'Switchboard', order: 0, scope: 'site', tests: [{ id: 'mst', label: 'Board', order: 0 }] }],
}
const mixedSnap = buildReportSnapshot({
  visit: {
    siteResults: { template: mixed, results: { ms: { mst: 'PASS' } } },
    rooms: { a: { template: mixed, results: { main: { mt: 'PASS' } } } },
  },
  rooms: [{ id: 'a', name: 'Lounge' }, { id: 'b', name: 'Laundry' }],
})
log('a check with room work still reports every room, opened or not',
  mixedSnap.rooms.map(r => [r.name, r.tested].join()).join('|') === 'Lounge,true|Laundry,false' &&
  mixedSnap.rooms[0].sections[0].label === 'Main test list' && mixedSnap.site.sections.length === 1)
log('a list that has only room sections keeps its empty main list, as Custom List always has',
  buildReportSnapshot({
    visit: { rooms: { a: { template: { tests: [], sections: [{ id: 's', label: 'Named', tests: [] }] }, sections: { s: true } } } },
    rooms: [{ id: 'a' }],
  }).rooms[0].sections.map(x => x.label).join() === 'Main test list,Named')

// Which items a report covers, and what stood there on the day.
const dayTest = { id: 'x', label: 'Trip time', type: 'measure', unit: 'ms' }
const dayTemplate = { tests: [], sections: [{ id: 's', label: 'RCD', scope: 'item', assetType: 'rcd', tests: [dayTest] }] }
const dayAssets = [
  { id: 'old', assetType: 'rcd', label: 'Replaced since', createdAt: '2025-01-01T00:00:00Z', removedAt: '2026-06-01T00:00:00Z' },
  { id: 'gone', assetType: 'rcd', label: 'Gone before the visit', createdAt: '2025-01-01T00:00:00Z', removedAt: '2025-06-01T00:00:00Z' },
  { id: 'kept', assetType: 'rcd', label: 'Still there', createdAt: '2025-01-01T00:00:00Z' },
  { id: 'later', assetType: 'rcd', label: 'Installed since', createdAt: '2026-06-01T00:00:00Z' },
  { id: 'undated', assetType: 'rcd', label: 'No dates' },
]
const dayVisit = (completedAt, extra = {}) => ({
  completedAt,
  rooms: {},
  siteResults: { template: dayTemplate, results: {}, readings: {}, ...extra },
})
const dayItems = s => s.site.sections[0].items.map(i => i.label).join()
const onTheDay = buildReportSnapshot({ visit: dayVisit('2026-01-15T00:00:00Z'), assets: dayAssets })
log('a finished visit covers what stood there when it finished',
  dayItems(onTheDay) === 'Replaced since,Still there,No dates', dayItems(onTheDay))
log('and its equipment list says the same',
  onTheDay.equipment.map(e => e.label).join() === 'Replaced since,Still there,No dates', onTheDay.equipment.map(e => e.label).join())
const stillOpen = buildReportSnapshot({ visit: dayVisit(null), assets: dayAssets })
log('a visit still open covers what is there now',
  dayItems(stillOpen) === 'Still there,Installed since,No dates' &&
  stillOpen.equipment.map(e => e.label).join() === 'Still there,Installed since,No dates', dayItems(stillOpen))
const readingOnly = buildReportSnapshot({
  visit: dayVisit('2026-01-15T00:00:00Z', { readings: { s: { gone: { x: { value: 24, unit: 'ms' } } } } }),
  assets: dayAssets,
})
const goneItem = readingOnly.site.sections[0].items.find(i => i.id === 'gone')
log('an item holding only a reading keeps its place and its reading',
  goneItem?.tests[0].answer === '24 ms', goneItem?.tests[0].answer)
log('but it is not on the equipment list if it had already gone',
  !readingOnly.equipment.some(e => e.label === 'Gone before the visit'))

// A failed smoke alarm, and a note left waiting for its timeframe.
const alarmTemplate = getTemplate('qld_smoke_alarm')
const alarmSection = alarmTemplate.sections[0]
const storeySection = alarmTemplate.sections[1]
const alarmVisit = {
  rooms: {},
  siteResults: {
    template: alarmTemplate,
    results: {
      [alarmSection.id]: {
        al1: { [alarmSection.tests[10].id]: 'FAIL' },
        al2: { [alarmSection.tests[0].id]: 'FAIL' },
        al3: { [alarmSection.tests[7].id]: 'FAIL', [alarmSection.tests[11].id]: 'FAIL' },
      },
      [storeySection.id]: { [storeySection.tests[1].id]: 'FAIL' },
    },
    troubleshooting: {
      [noteKey(alarmSection.tests[10].id, 'al1')]: 'No sound when the button is pressed',
      [noteKey(alarmSection.tests[7].id, 'al3')]: 'Too close to the downlight',
      [storeySection.tests[1].id]: 'Repair recommended within [timeframe].',
    },
  },
}
const alarmAssets = [
  { id: 'al1', assetType: 'smoke_alarm', label: 'Hall alarm' },
  { id: 'al2', assetType: 'smoke_alarm', label: 'Bedroom alarm' },
  { id: 'al3', assetType: 'smoke_alarm', label: 'Landing alarm' },
]
const alarmSnap = buildReportSnapshot({ visit: alarmVisit, assets: alarmAssets })
log('the smoke alarm checks ask why it failed, with no suggested wording',
  ['vic_smoke_alarm', 'qld_smoke_alarm', 'smoke_alarm_check'].every(id => {
    const t = getTemplate(id)
    return !t.failNotes && t.sections.find(s => s.scope === 'item').tests.some(x => x.onFail === 'replace')
  }))
log('a test the store seeds carries the rule; one that does not has no such field',
  alarmSection.tests[10].onFail === 'replace' && alarmSection.tests[7].onFail === undefined &&
  alarmSection.tests[10].id && alarmSection.tests[10].order === 10)
log('a placement or cleaning fail keeps its reason and does not condemn the alarm',
  same(alarmSnap.site.failed.filter(f => f.item === 'Landing alarm'), [
    { label: alarmSection.tests[7].label, item: 'Landing alarm', note: 'Too close to the downlight' },
    { label: alarmSection.tests[11].label, item: 'Landing alarm', note: '' },
  ]), JSON.stringify(alarmSnap.site.failed.filter(f => f.item === 'Landing alarm')))
log('a failed alarm has to be replaced, keeping the reason it failed',
  same(alarmSnap.site.failed[0], {
    label: alarmSection.tests[10].label, item: 'Hall alarm',
    note: 'No sound when the button is pressed', mustReplace: true,
  }), JSON.stringify(alarmSnap.site.failed[0]))
log('a whole-property test does not condemn an alarm',
  !alarmSnap.site.failed.find(f => f.label === storeySection.tests[1].label)?.mustReplace)
log('a note still holding its timeframe is marked unfinished',
  alarmSnap.site.failed.find(f => f.label === storeySection.tests[1].label)?.unfinished === true &&
  !alarmSnap.site.failed[0].unfinished)
log('whole-site fails say which item each belongs to',
  siteFails(alarmVisit.siteResults).map(f => f.itemId ?? '-').join() === 'al1,al2,al3,al3,-',
  siteFails(alarmVisit.siteResults).map(f => f.itemId ?? '-').join())

// Whole-site fails reach Home, and only while the visit can still take a note.
const homeSite = structuredClone(siteVisit.siteResults)
homeSite.troubleshooting = { [noteKey(tid(4, 1), 'rcd2')]: vic.failNotes[1] } // timeframe not filled in; section E has no note
const homeVisit = { id: 'v1', kind: 'vic_electrical_safety', startedAt: '2026-10-28T23:00:00Z', rooms: {}, exports: [], siteResults: homeSite }
const homeClients = visit => [{
  id: 'c1', name: 'Rental Co',
  locations: [{ id: 'l1', address: '1 High St', suburb: 'Town', floors: [{ id: 'f1', label: 'Ground', rooms: [{ id: 'garage', name: 'Garage' }] }], visits: [visit] }],
}]
const homeRow = attention(homeClients(homeVisit)).find(r => r.type === 'fails')
log('Home flags whole-site fails with no finished note',
  homeRow?.count === 2 && homeRow.roomName === 'Whole site' && homeRow.roomId === null, JSON.stringify(homeRow))
log('Home counts them as the visit\'s fails', openWork(homeClients(homeVisit))[0].fails === 2)
const noted = structuredClone(homeVisit)
noted.siteResults.troubleshooting = {
  [noteKey(tid(4, 1), 'rcd2')]: 'Repair recommended within 6 months.',
  [tid(5, 0)]: 'Hall alarm missing',
}
log('notes written in full clear the flag',
  !attention(homeClients(noted)).some(r => r.type === 'fails'))
log('a finished visit is not chased',
  !attention(homeClients({ ...homeVisit, completedAt: '2026-10-29T03:00:00Z' })).some(r => r.type === 'fails'))

// A room's status when all it holds is a reading.
const statusEntry = readings => {
  store.set('fc.clients', JSON.stringify(homeClients({ ...homeVisit, siteResults: undefined })))
  return saveRoomEntry('c1', 'l1', 'v1', 'garage', { template: everything, results: { main: {} }, readings })
}
log('a room holding only a reading is in progress',
  statusEntry({ main: { t4: { value: '24', unit: 'ms' } } })?.status === 'in-progress')
log('a blank reading leaves it not started',
  statusEntry({ main: { t4: { value: '  ', unit: 'ms' } } })?.status === 'not-started')

// ── The Excel export ─────────────────────────────────────────────────────────
const rowsOf = async wb => {
  const buf = await wb.xlsx.writeBuffer()
  const back = new ExcelJS.Workbook()
  await back.xlsx.load(buf)
  const ws = back.worksheets[0]
  const rows = []
  ws.eachRow(r => rows.push(r))
  return rows
}
// A merged row's second cell reads back as the first; count it once.
const textOf = r =>
  [1, 2]
    .map(i => {
      const c = r.getCell(i)
      return c.isMerged && c.master.address !== c.address ? '' : String(c.value ?? '')
    })
    .join('|')

const siteRows = await rowsOf(await buildWorkbook({
  client: { name: 'Rental Co' }, location: { address: '1 High St' }, visit: siteVisit,
  rooms: siteRooms, revision: 2, reportTitle: 'Electrical Safety Check', assets: rcds,
}))
const siteText = siteRows.map(textOf)
const at = label => siteText.findIndex(t => t.startsWith(label))
log('the whole-site check prints with no "not tested" rooms',
  at('Whole site|') > 0 && at('Room 1') === -1 && !siteText.some(t => t.startsWith('Not tested')))
const mixedText = (await rowsOf(await buildWorkbook({
  client: { name: 'Rental Co' }, location: {}, revision: 1,
  visit: {
    siteResults: { template: mixed, results: { ms: { mst: 'PASS' } } },
    rooms: { a: { template: mixed, results: { main: { mt: 'PASS' } } } },
  },
  rooms: [{ id: 'a', name: 'Lounge' }],
}))).map(textOf)
log('the whole site comes before the rooms',
  mixedText.indexOf('Whole site|') > 0 && mixedText.indexOf('Whole site|') < mixedText.indexOf('Room 1: Lounge|'))
log('choices, readings and text print as answered',
  siteText.includes('Main switchboard|Included') && siteText.includes('Mains earth conductor|0.12 Ω') &&
  siteText.includes('Each defect and what was done (repaired, replaced, retested)|Replaced cracked socket-outlet in the laundry'))
log('each item gets its own heading and rows',
  siteText.includes('RCD 1 — lights (Garage)|') && siteText.includes('Trip time|24 ms — PASS') &&
  at('RCD 2 — power|') > at('RCD 1 — lights (Garage)|'))
log('fails are listed with the item they belong to',
  siteText.includes(`RCD 2 — power — Push-button test|${vic.failNotes[0]}`))
const noRow = siteRows.find(r => textOf(r).endsWith('|No'))
log('a No prints in the fail colour', noRow?.getCell(2).font?.color?.argb === 'FFC22E1C')

// Long text stays readable: AV's short labels are the only ones left alone.
const longRow = siteRows.find(r => textOf(r).startsWith('All smoke alarms correctly installed'))
log('a long label wraps, in a row tall enough to show it',
  longRow?.getCell(1).alignment?.wrapText === true && longRow.height >= 34, `height=${longRow?.height}`)
const multiLine = structuredClone(siteVisit)
multiLine.siteResults.results[sec(6).id][tid(6, 0)] = 'Replaced socket-outlet\nRetested after repair'
const multiRow = (await rowsOf(await buildWorkbook({
  client: {}, location: {}, visit: multiLine, rooms: [], revision: 1,
}))).find(r => textOf(r).includes('Retested after repair'))
log('a text answer with line breaks wraps',
  multiRow?.getCell(2).alignment?.wrapText === true && multiRow.height >= 34, `height=${multiRow?.height}`)
const shortRow = siteRows.find(r => textOf(r).startsWith('Trip time'))
log('a short row is left as it was', !shortRow?.getCell(1).alignment?.wrapText && !shortRow?.height)

const alarmText = (await rowsOf(await buildWorkbook({
  client: {}, location: {}, visit: alarmVisit, rooms: [], assets: alarmAssets, revision: 1, sheetName: 'Smoke Alarm Inspection',
}))).map(textOf)
log('a failed alarm prints why, and that it has to be replaced',
  alarmText.includes(`Hall alarm — ${alarmSection.tests[10].label}|No sound when the button is pressed — Has to be replaced`))
log('with no reason yet, it still prints that it has to be replaced',
  alarmText.includes(`Bedroom alarm — ${alarmSection.tests[0].label}|Has to be replaced`))
log('a placement fail prints only its reason',
  alarmText.includes(`Landing alarm — ${alarmSection.tests[7].label}|Too close to the downlight`))
log('a cleaning fail with no reason yet prints nothing about replacing it',
  alarmText.includes(`Landing alarm — ${alarmSection.tests[11].label}|`))

// The worksheet takes the check's own name; AV keeps the one it has always had.
const sheetOf = async sheetName =>
  (await buildWorkbook({ client: {}, location: {}, visit: { rooms: {} }, rooms: [], revision: 1, sheetName })).worksheets[0].name
log('a workflow names its own worksheet',
  (await sheetOf(pageConfig('vic_electrical_safety').sheetName)) === 'Electrical Safety Check' &&
  (await sheetOf(pageConfig('qld_smoke_alarm').sheetName)) === 'Smoke Alarm Inspection')
log('AV and custom reports stay on "PM Report"',
  (await Promise.all(['maintenance', 'commissioning', 'custom'].map(id => sheetOf(pageConfig(id).sheetName))))
    .every(name => name === 'PM Report'))

// An AV room, as WorkflowPage stores it: the export is the one Pemcora has
// always produced — no whole-site block, and the same rows in the same order.
const pm = getTemplate('maintenance')
const avVisit = {
  technician: 'Pat', startedAt: '2026-10-01T01:00:00Z', completedAt: '2026-10-01T05:00:00Z',
  rooms: {
    r1: {
      template: pm,
      results: { main: { [pm.tests[0].id]: 'PASS', [pm.tests[1].id]: 'FAIL', [pm.tests[2].id]: 'NA' } },
      sections: { [pm.sections[0].id]: true, [pm.sections[1].id]: false },
      troubleshooting: { [pm.tests[1].id]: 'Panel rebooted' },
      comments: 'Rack tidy required',
    },
  },
}
const avRows = await rowsOf(await buildWorkbook({
  client: { name: 'Equinix' }, location: { address: '8 Grand Avenue' }, visit: avVisit,
  rooms: [{ id: 'r1', name: 'Reception', floorLabel: 'Ground' }, { id: 'r2', name: 'Boardroom', floorLabel: 'Ground' }],
  revision: 1,
}))
const avText = avRows.map(textOf)
const avLongest = avRows.find(r => textOf(r).startsWith('Booking panel signed in'))
log('AV\'s longest label is left as it has always been',
  !avLongest?.getCell(1).alignment?.wrapText && !avLongest?.height)
const expected = [
  'Preventative Maintenance|', 'Client|Equinix', 'Address|8 Grand Avenue', 'Technician|Pat',
  'Visit started|2026-10-01', 'Visit completed|2026-10-01',
  'Room 1: Reception|', 'Floor|Ground', 'Main test list|',
  'Correct Time and Date|PASS', 'Room Wake On Touch|FAIL', 'Test call performed|N/A',
  ...pm.tests.slice(3).map(t => `${t.label}|`),
  'Room controls|', ...pm.sections[0].tests.map(t => `${t.label}|`),
  'Troubleshooting|', 'Room Wake On Touch|Panel rebooted', 'Comments|', 'Rack tidy required|',
  'Room 2: Boardroom|', 'Floor|Ground', 'Not tested during this visit|',
]
log('an AV visit exports exactly as before', same(avText, expected),
  avText.find((t, i) => t !== expected[i]) ?? '')
