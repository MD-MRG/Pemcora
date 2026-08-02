import { COMMISSIONING, MAINTENANCE, CUSTOM } from '../data/testLists.js'

// Test templates, seeded from the supplied spreadsheets on first use.
//
//   template = { mainLabel, sections: [ { id, label, order, tests: [...] } ] }
//
// One shape serves Maintenance, Commissioning and Custom List — Custom List is
// simply a template whose sections the technician names. This is what the
// Settings editor will edit, so it lives apart from the client data.

const KEY = 'fc.templates'

const uid = () => crypto.randomUUID()
const toTests = labels => labels.map((label, i) => ({ id: uid(), label, order: i }))

function seed(kind) {
  if (kind === 'custom') {
    return { mainLabel: 'Main test list', sections: [], tests: [] }
  }
  const src = kind === 'commissioning' ? COMMISSIONING : MAINTENANCE
  return {
    mainLabel: 'Main test list',
    tests: toTests(src.main),
    sections: [
      { id: uid(), label: 'Room controls', order: 0, tests: toTests(src.roomControls) },
      {
        id: uid(),
        label: 'Additional AV Sources',
        order: 1,
        tests: toTests(src.additionalSources),
      },
    ],
  }
}

function readAll() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable — the session still works */
  }
}

// Each workflow owns its own copy, so editing Maintenance never touches
// Commissioning even though they start out nearly identical.
export function getTemplate(kind) {
  const all = readAll()
  if (!all[kind]) {
    all[kind] = seed(kind)
    writeAll(all)
  }
  return all[kind]
}

export function saveTemplate(kind, template) {
  const all = readAll()
  all[kind] = template
  writeAll(all)
  return template
}

export function resetTemplate(kind) {
  const all = readAll()
  all[kind] = seed(kind)
  writeAll(all)
  return all[kind]
}

export { CUSTOM }
