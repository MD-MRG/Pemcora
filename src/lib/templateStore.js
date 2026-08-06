import { COMMISSIONING, MAINTENANCE, CUSTOM } from '../data/testLists.js'
import { readTemplates, writeTemplates, hydrateSync, hasAdapter } from './cache.js'
import { localAdapter } from './adapters/local.js'

// Test templates, seeded from the supplied spreadsheets on first use.
//
//   template = { mainLabel, sections: [ { id, label, order, tests: [...] } ] }
//
// One shape serves Maintenance, Commissioning and Custom List — Custom List is
// simply a template whose sections the technician names. This is what the
// Settings editor edits, so it lives apart from the client data.
//
// Backed by cache.js, so these persist to the team's `team_templates` rows when
// signed in and to localStorage otherwise. Synchronous, because WorkflowPage
// reads a template during render to decide what to draw.
//
// Seeding stays here rather than in SQL on purpose: src/data/testLists.js is
// the single source of truth, and duplicating ~60 test labels into a migration
// guarantees the two drift the first time a list is edited.

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
  if (!hasAdapter()) hydrateSync(localAdapter)
  return readTemplates() ?? {}
}

const isBlank = t => !t || Object.keys(t).length === 0

// Each workflow owns its own copy, so editing Maintenance never touches
// Commissioning even though they start out nearly identical.
//
// create_team leaves the three rows empty rather than seeding them, so the
// first read fills them in. If a plain member gets there first the write is
// refused by RLS — the template is still correct in memory for their session,
// and the next admin to open the app persists it.
export function getTemplate(kind) {
  const all = readAll()
  if (isBlank(all[kind])) {
    all[kind] = seed(kind)
    writeTemplates(all)
  }
  return all[kind]
}

export function saveTemplate(kind, template) {
  const all = readAll()
  all[kind] = template
  writeTemplates(all)
  return template
}

export function resetTemplate(kind) {
  const all = readAll()
  all[kind] = seed(kind)
  writeTemplates(all)
  return all[kind]
}

export { CUSTOM }
