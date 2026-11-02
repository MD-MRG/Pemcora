import core from './core.js'
import av from './av.js'
import vicRental from './vic_rental.js'
import qldElectrical from './qld_electrical.js'
import electricalGeneral from './electrical_general.js'

// The pack registry: every pack, the workflows it unlocks, each workflow's page
// wording and the lists a team's template starts from.
//
// It matches the catalogue in supabase/migrations/0006_editions.sql, which
// holds only ids and the facts the server needs — tests/packs.mjs checks the
// two agree. The lists themselves live here and never in SQL: duplicating them
// into a migration guarantees the two drift the first time a list is edited.
//
// These are seeds only. Once a team exists, its lists are edited in-app through
// the test-list editor, and edits never alter already-completed work.
//
// A pack marked `proposed` holds lists a licensed electrician hasn't checked
// yet. No page may offer its workflows until that check is done and the flag
// is removed.
//
// A seed is { main: [test], sections: [{ label, tests: [test], …section }],
// …template } where a test is a label, or { label, …test } once it needs more
// than PASS/FAIL/N/A. templateStore.js turns it into a team's template.

/* ── Structural note ─────────────────────────────────────────────────────────
   Custom List needs an arbitrary number of user-named sections, and the section
   headings themselves ("Main test list", "Room specifics") must be renameable.
   That is more general than the previous app's fixed three lists, so the schema
   models a template as:

       template = { mainLabel, sections: [ { id, label, order, tests[] } ] }

   Commissioning and Maintenance are then just templates that ship with two
   sections pre-named "Room controls" and "Additional AV Sources" — no special
   casing, and one editor serves every workflow.

   Section gating (decided): the old YES/NO "Room specifics" gate is dropped.
   Each section carries its own per-room toggle, defaulting to whatever the
   previous room in the same job used. A room with nothing extra therefore costs
   zero taps, and on a 20-room site the common configuration is set once rather
   than repeated. Any room is still free to differ.

   Unchanged from before: switching a section off preserves its results in
   storage and merely excludes them from the export, so toggling is never
   destructive.
   ────────────────────────────────────────────────────────────────────────── */

// Packs share lists (the electrical safety check), so nothing may change one
// in place: an edit to one workflow's seed would quietly reach the others.
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }
  return value
}

export const PACKS = deepFreeze([core, av, vicRental, qldElectrical, electricalGeneral])

export const WORKFLOWS = PACKS.flatMap(pack =>
  pack.workflows.map(w => ({ ...w, packId: pack.id })),
)

const byId = new Map(WORKFLOWS.map(w => [w.id, w]))

export function workflow(id) {
  const found = byId.get(id)
  if (!found) throw new Error(`Unknown workflow: ${id}`)
  return found
}

// What WorkflowPage takes. A workflow is both the visits' `kind` and the
// template it reads, so a page never has to say either twice.
export const pageConfig = id => ({ kind: id, templateKind: id, ...workflow(id).page })

export const packById = id => PACKS.find(p => p.id === id) ?? null

// The packs a team can be given: not core, which every team has, and none whose
// lists a licensed electrician hasn't checked yet.
export const offeredPacks = () => PACKS.filter(p => p.id !== 'core' && !p.proposed)
