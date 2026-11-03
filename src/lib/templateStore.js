import { workflow } from '../data/packs/index.js'
import { readTemplates, writeTemplates, hydrateSync, hasAdapter } from './cache.js'
import { localAdapter } from './adapters/local.js'

// Test templates, seeded from the pack files on first use.
//
//   template = { mainLabel, sections: [ { id, label, order, tests: [...] } ] }
//
// One shape serves every workflow — Custom List is simply a template whose
// sections the technician names. This is what the Settings editor edits, so it
// lives apart from the client data.
//
// Backed by cache.js, so these persist to the team's `team_templates` rows when
// signed in and to localStorage otherwise. Synchronous, because WorkflowPage
// reads a template during render to decide what to draw.
//
// Seeding stays here rather than in SQL on purpose: the pack files in
// src/data/packs/ are the single source of truth, and duplicating the test
// labels into a migration guarantees the two drift the first time a list is
// edited.

const uid = () => crypto.randomUUID()

// A test in a seed is a bare label, or an object once it needs more than
// PASS/FAIL/N/A. Every copy gets fresh ids, so no two teams share one.
const toTests = tests =>
  tests.map((test, i) =>
    typeof test === 'string'
      ? { id: uid(), label: test, order: i }
      : { id: uid(), ...test, order: i },
  )

// Throws for a workflow no pack defines, rather than handing it some other
// workflow's list. The pack files are frozen and shared between packs, so the
// template gets its own copy of everything in them.
function seed(kind) {
  const { main, sections, ...rest } = structuredClone(workflow(kind).seed)
  return {
    mainLabel: 'Main test list',
    ...rest,
    tests: toTests(main),
    sections: sections.map(({ tests, ...section }, i) => ({
      id: uid(),
      ...section,
      order: i,
      tests: toTests(tests),
    })),
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
//
// That first read happens while a page draws, so the write says so.
export function getTemplate(kind) {
  const all = readAll()
  if (isBlank(all[kind])) {
    all[kind] = seed(kind)
    writeTemplates(all, { duringRender: true })
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
