/**
 * Pack files — the registry in src/data/packs/ against the database catalogue.
 *
 * Not a browser suite: it imports the pack files and templateStore.js straight
 * into Node, with an in-memory localStorage standing in for the browser's.
 *
 * What it holds the code to:
 *   - every pack and workflow in the migrations' catalogue has a pack file
 *     entry, in the same pack and with the same label, and the code adds none
 *   - the AV lists are exactly the ones Pemcora shipped with (moved, not edited)
 *   - the proposed electrician packs say so, and the electrical safety list is
 *     one list shared by all three electrical checks
 *   - every seed uses only the fields B2 defines, and turns into a template
 *     with fresh ids, its own copy of everything, and AV tests left untyped
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const log = (k, v, extra = '') =>
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const throws = fn => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// templateStore.js reads and writes localStorage through the cache, so give it
// one before anything imports it.
const store = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  },
})

const { PACKS, WORKFLOWS, workflow, pageConfig } = await import('../src/data/packs/index.js')
const { getTemplate, resetTemplate } = await import('../src/lib/templateStore.js')

// ── The catalogue, as the migrations leave it ───────────────────────────────
// Later rows win, exactly as `on conflict … do update` does when the files run
// in order.
const sql = readdirSync(join(ROOT, 'supabase/migrations'))
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8'))
  .join('\n')

const blocks = table =>
  [...sql.matchAll(new RegExp(`insert into public\\.${table} \\([^)]*\\) values([\\s\\S]*?)on conflict`, 'g'))]
    .map(m => m[1])

const catalogPacks = new Map()
for (const block of blocks('packs'))
  for (const [, id, label] of block.matchAll(/\(\s*'([a-z_]+)',\s*'([^']*)',\s*\d+\s*\)/g))
    catalogPacks.set(id, label)

const catalogWorkflows = new Map()
for (const block of blocks('workflows'))
  for (const [, id, packId, label, months, fixed] of block.matchAll(
    /\(\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'([^']*)',\s*(null|\d+),\s*(true|false)\s*\)/g,
  ))
    catalogWorkflows.set(id, { packId, label, months: months === 'null' ? null : Number(months), fixed: fixed === 'true' })

log('the catalogue parses: 5 packs, 9 workflows', catalogPacks.size === 5 && catalogWorkflows.size === 9,
  `${catalogPacks.size} packs, ${catalogWorkflows.size} workflows`)

// ── Packs and workflows match the catalogue ─────────────────────────────────
const codePacks = new Map(PACKS.map(p => [p.id, p.label]))
log('every catalogue pack has a pack file, with its label',
  [...catalogPacks].every(([id, label]) => codePacks.get(id) === label),
  [...catalogPacks].filter(([id, label]) => codePacks.get(id) !== label).map(([id]) => id).join(', '))
log('the code adds no pack the catalogue lacks', [...codePacks.keys()].every(id => catalogPacks.has(id)))

const mismatched = [...catalogWorkflows].filter(([id, w]) => {
  const found = WORKFLOWS.find(x => x.id === id)
  return !found || found.packId !== w.packId || found.label !== w.label
})
log('every catalogue workflow has an entry, in its pack, with its label', mismatched.length === 0,
  mismatched.map(([id]) => id).join(', '))
log('the code adds no workflow the catalogue lacks', WORKFLOWS.every(w => catalogWorkflows.has(w.id)))
log('no workflow is defined twice', new Set(WORKFLOWS.map(w => w.id)).size === WORKFLOWS.length)

// How often each recurs (C3): the pack file says what the catalogue says, and a
// workflow with no interval there neither recurs nor is fixed.
const intervalsOff = [...catalogWorkflows].filter(([id, w]) => {
  const found = WORKFLOWS.find(x => x.id === id)?.interval
  return found ? found.months !== w.months || found.fixed !== w.fixed : w.months !== null || w.fixed
})
log('every workflow\'s interval matches the catalogue', intervalsOff.length === 0, intervalsOff.map(([id]) => id).join(', '))
log('PM recurs with no default; commissioning and Custom List don\'t recur',
  same(WORKFLOWS.find(w => w.id === 'maintenance').interval, { months: null, fixed: false }) &&
    !WORKFLOWS.find(w => w.id === 'commissioning').interval && !WORKFLOWS.find(w => w.id === 'custom').interval)

// ── Page wording ─────────────────────────────────────────────────────────────
const PAGE_FIELDS = ['title', 'progressNoun', 'startLabel', 'newLabel', 'emptyLine', 'reportTitle']
log('every workflow has its page wording',
  WORKFLOWS.every(w => PAGE_FIELDS.every(f => typeof w.page[f] === 'string' && w.page[f].trim())))
// Excel refuses a worksheet name over 31 characters or holding any of these.
const validSheet = name => name.length <= 31 && !/[\\/?*[\]:]/.test(name)
log('the new workflows name a worksheet Excel accepts; AV and custom name none',
  WORKFLOWS.every(w =>
    ['maintenance', 'commissioning', 'custom'].includes(w.id)
      ? w.page.sheetName === undefined
      : typeof w.page.sheetName === 'string' && validSheet(w.page.sheetName)))
log('a page config is its workflow for both kind and template',
  WORKFLOWS.every(w => pageConfig(w.id).kind === w.id && pageConfig(w.id).templateKind === w.id))
log('the AV and custom pages keep their wording',
  same(pageConfig('maintenance'), {
    kind: 'maintenance', templateKind: 'maintenance', title: 'Preventative Maintenance',
    progressNoun: 'Preventative Maintenance', startLabel: 'Start PM', newLabel: 'Start new visit',
    emptyLine: 'No PM recorded for this location', reportTitle: 'Preventative Maintenance',
  }) &&
  same(pageConfig('commissioning'), {
    kind: 'commissioning', templateKind: 'commissioning', title: 'Commissioning',
    progressNoun: 'Commissioning', startLabel: 'Start commissioning',
    newLabel: 'Start new commissioning', emptyLine: 'No commissioning recorded for this location',
    reportTitle: 'Commissioning',
  }) &&
  same(pageConfig('custom'), {
    kind: 'custom', templateKind: 'custom', title: 'Custom List', progressNoun: 'Custom list',
    startLabel: 'Start custom list', newLabel: 'Start new custom list',
    emptyLine: 'No custom list recorded for this location', reportTitle: 'Custom List',
  }))
log('an unknown workflow is refused, not given another list', throws(() => workflow('nope')))

// ── The AV lists, exactly as shipped ─────────────────────────────────────────
const ROOM_CONTROLS = ['Room ON/OFF', 'Source selection', 'Speaker Volume', 'Speaker Mute',
  'Mic Volume', 'Mic Mute', 'Ceiling Mic LED Mute Sync', 'Camera Control', 'Camera Presets']
const SOURCES = ['Signage', 'Apple TV', 'Foxtel', 'FTA STB', 'Sonos']
const AV = {
  maintenance: ['Correct Time and Date', 'Room Wake On Touch', 'Test call performed',
    'Audio In room', 'Video In room', 'Audio to Remote participants',
    'Video to Remote participants', 'Content video In room', 'Content video Remote participants',
    'Content audio In room', 'Content audio Remote participants', 'Video quality',
    'Audio quality', 'Cameras working as specified', 'Hearing Augmentation',
    'TV Remote available', 'FW updated', 'Booking panel signed in with calendar displayed', 'BYOD'],
  commissioning: ['Correct Time and Date', 'Room Wake On Touch',
    'Test network connectivity to all AV devices', 'Display image calibration and scaling',
    'Audio DSP routing and tuning', 'Teams room account signed in',
    'Touch panel functionality check', 'Test call performed', 'Audio In room',
    'Audio to Remote participants', 'Video In room', 'Video to Remote participants',
    'Audio quality', 'Video quality', 'Content video In room', 'Content video Remote participants',
    'Content audio In room', 'Content audio Remote participants', 'Cameras working as specified',
    'Hearing Augmentation', 'TV Remote available', 'TV Volume turned down', 'FW updated',
    'Booking panel signed in with calendar displayed', 'BYOD'],
}
for (const kind of ['maintenance', 'commissioning']) {
  log(`${kind} seed is the shipped list, unchanged`,
    same(workflow(kind).seed, {
      main: AV[kind],
      sections: [
        { label: 'Room controls', tests: ROOM_CONTROLS },
        { label: 'Additional AV Sources', tests: SOURCES },
      ],
    }))
}
log('the custom seed is empty', same(workflow('custom').seed, { main: [], sections: [] }))

// ── Proposed packs and shared lists ──────────────────────────────────────────
const proposed = PACKS.filter(p => p.proposed).map(p => p.id).sort()
log('the three electrician packs, and only they, are marked proposed',
  same(proposed, ['electrical_general', 'qld_electrical', 'vic_rental']), proposed.join(', '))

const general = workflow('electrical_safety').seed
const vic = workflow('vic_electrical_safety').seed
log('baseline and Queensland electrical checks are one list',
  workflow('qld_electrical_safety').seed === general)
log('the Victorian check shares its tests, under the form\'s section letters',
  vic.sections.length === general.sections.length &&
  vic.sections.every((s, i) => s.tests === general.sections[i].tests &&
    s.label === `${['B', 'C', 'D1', 'D2', 'D3', 'E', 'F'][i]}. ${general.sections[i].label}`),
  vic.sections.map(s => s.label).join(' | '))
log('electrical sections hold 16, 20, 12, 14, 4, 1 and 1 tests',
  same(general.sections.map(s => s.tests.length), [16, 20, 12, 14, 4, 1, 1]))
log('RCD testing repeats for each RCD',
  general.sections[4].scope === 'item' && general.sections[4].assetType === 'rcd')

const alarms = id => workflow(id).seed.sections.find(s => s.scope === 'item')
log('each smoke alarm check repeats for each alarm, with 7, 12 and 6 tests',
  ['vic_smoke_alarm', 'qld_smoke_alarm', 'smoke_alarm_check']
    .every(id => alarms(id)?.assetType === 'smoke_alarm') &&
  same(['vic_smoke_alarm', 'qld_smoke_alarm', 'smoke_alarm_check'].map(id => alarms(id).tests.length), [7, 12, 6]))
const condemning = id => alarms(id).tests.filter(t => t.onFail === 'replace').map(t => t.label)
log('only tests that fault the alarm itself say it has to be replaced',
  same(condemning('vic_smoke_alarm'), [
    'Marked AS 3786',
    "Works when tested to the manufacturer's instructions",
    'Hard-wired with a backup battery, if the building dates from after 1 August 1997',
    'Under 10 years old',
  ]) &&
  same(condemning('qld_smoke_alarm'), [
    'Photoelectric, marked AS 3786-2014',
    'No ionisation sensor',
    'Under 10 years old (manufacture date on the alarm)',
    'Hard-wired with a backup battery, or a sealed 10-year battery (a hard-wired alarm is only replaced with another hard-wired one)',
    'Works when tested (replaced immediately if not)',
  ]) &&
  same(condemning('smoke_alarm_check'), [
    'Marked AS 3786',
    "Works when tested to the manufacturer's instructions",
    'Under 10 years old',
  ]))
log('placement, battery, interconnection and cleaning tests take an ordinary note',
  ['vic_smoke_alarm', 'qld_smoke_alarm', 'smoke_alarm_check'].every(id =>
    alarms(id).tests
      .filter(t => typeof t === 'string')
      .every(label => /Correctly installed|Battery|Interconnected|On the ceiling|At least \d+ mm|Cleaned/.test(label)) &&
    alarms(id).tests.filter(t => typeof t === 'string').length === alarms(id).tests.length - condemning(id).length))
log('nothing else in any list condemns its item',
  WORKFLOWS.every(w => w.seed.sections.every(s => s.onFail === undefined)) &&
  WORKFLOWS.filter(w => !['vic_smoke_alarm', 'qld_smoke_alarm', 'smoke_alarm_check'].includes(w.id))
    .every(w => [...w.seed.main, ...w.seed.sections.flatMap(s => s.tests)].every(t => t.onFail === undefined)))
log('fail-note suggestions are on the electrical checks only',
  WORKFLOWS.filter(w => w.seed.failNotes).map(w => w.id).sort().join() ===
    'electrical_safety,qld_electrical_safety,vic_electrical_safety')
log('Queensland checks every bedroom has an alarm',
  same(workflow('qld_smoke_alarm').seed.coverage, [{ roomTypes: ['bedroom'], assetType: 'smoke_alarm', min: 1 }]))

// ── Every seed uses only B2's fields ────────────────────────────────────────
const TYPES = ['check', 'choice', 'yesno', 'measure', 'text']
const SCOPES = ['room', 'site', 'item']
const testProblem = t => {
  if (typeof t === 'string') return t.trim() ? null : 'blank label'
  if (!t.label?.trim()) return 'blank label'
  const type = t.type ?? 'check'
  if (!TYPES.includes(type)) return `type ${type}`
  if (type === 'choice' && !(t.options?.length > 1)) return `${t.label}: no options`
  if (type === 'measure' && !t.unit) return `${t.label}: no unit`
  return null
}
const problems = []
for (const w of WORKFLOWS) {
  for (const t of w.seed.main) if (testProblem(t)) problems.push(`${w.id}: ${testProblem(t)}`)
  for (const s of w.seed.sections) {
    if (!s.label?.trim()) problems.push(`${w.id}: unnamed section`)
    if (s.scope && !SCOPES.includes(s.scope)) problems.push(`${w.id}/${s.label}: scope ${s.scope}`)
    if ((s.scope === 'item') !== !!s.assetType) problems.push(`${w.id}/${s.label}: assetType`)
    for (const t of s.tests) if (testProblem(t)) problems.push(`${w.id}/${s.label}: ${testProblem(t)}`)
  }
}
log('every seed uses only the test types and scopes B2 defines', problems.length === 0,
  problems.slice(0, 3).join(' | '))

log('the registry cannot be changed in place',
  Object.isFrozen(general.sections[0].tests[0].options) &&
  throws(() => general.sections[0].tests.push('x')) &&
  throws(() => { workflow('maintenance').seed.main[0] = 'x' }))

// ── Seeds become templates through templateStore ────────────────────────────
const pm = getTemplate('maintenance')
const pmTests = [pm.tests, ...pm.sections.map(s => s.tests)].flat()
log('the maintenance template is built as before',
  pm.mainLabel === 'Main test list' &&
  same(pm.tests.map(t => t.label), AV.maintenance) &&
  pm.tests.every((t, i) => t.order === i && Object.keys(t).sort().join() === 'id,label,order') &&
  same(pm.sections.map(s => [s.label, s.order, Object.keys(s).sort().join()]),
    [['Room controls', 0, 'id,label,order,tests'], ['Additional AV Sources', 1, 'id,label,order,tests']]) &&
  same(pm.sections[0].tests.map(t => t.label), ROOM_CONTROLS))
log('every test and section gets its own id',
  new Set([...pmTests, ...pm.sections].map(x => x.id)).size === pmTests.length + pm.sections.length)
log('the custom template is empty, as before',
  same(getTemplate('custom'), { mainLabel: 'Main test list', tests: [], sections: [] }))
log('the template is written to storage', !!JSON.parse(store.get('fc.templates') ?? '{}').maintenance)

const elec = getTemplate('vic_electrical_safety')
log('a typed template keeps its scopes, types, options and units',
  elec.sections.length === 7 &&
  elec.sections.every((s, i) => s.order === i && s.scope && s.id) &&
  elec.sections[4].assetType === 'rcd' &&
  elec.sections[0].tests[0].type === 'choice' && elec.sections[0].tests[0].options.length === 3 &&
  elec.sections[3].tests.every(t => t.type === 'measure' && t.unit === 'Ω') &&
  elec.sections[4].tests[3].unit === 'ms')
log('the template owns its copy of the shared list',
  !Object.isFrozen(elec.sections[0].tests[0].options) &&
  elec.sections[0].tests[0].options !== vic.sections[0].tests[0].options &&
  !throws(() => elec.sections[0].tests[0].options.push('Edited')) &&
  vic.sections[0].tests[0].options.length === 3)
log('a reset starts again from the pack file',
  resetTemplate('vic_electrical_safety').sections[0].tests[0].options.length === 3)
log('template-level rules come through', same(getTemplate('qld_smoke_alarm').coverage,
  [{ roomTypes: ['bedroom'], assetType: 'smoke_alarm', min: 1 }]))
log('an unknown workflow gets no template', throws(() => getTemplate('nope')))
