// How often checks are due (build plan 2.8, C3). Pure, so it runs in Node too.
//
// Each recurring workflow's pack file gives its interval as the catalogue has it
// ({ months, fixed }). The team can choose its own for any the law doesn't fix:
// a default for all its clients, and any client's own on top.

import { WORKFLOWS } from '../data/packs/index.js'
import { usesPack } from './entitlements.js'

/** The recurring checks this team uses, in the registry's order. */
export const recurringWorkflows = entitlements =>
  WORKFLOWS.filter(w => w.interval && usesPack(entitlements, w.packId))

/** 'every 12 months', 'every month'. */
export const everyText = months => (months === 1 ? 'every month' : `every ${months} months`)

/**
 * What applies to a client's sites, in words, when it has none of its own: the
 * team default, else the pack's, else nothing (PM, until the team sets one).
 */
export function fallbackText(workflow, teamMonths) {
  if (teamMonths) return `${everyText(teamMonths)}, the team default`
  if (workflow.interval?.months) return `${everyText(workflow.interval.months)}, the pack default`
  return 'not tracked as due'
}

/** A typed interval: { months } (null when blank), or { error }. */
export function readMonths(text) {
  const t = String(text ?? '').trim()
  if (!t) return { months: null }
  if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 120) return { error: 'Between 1 and 120 months.' }
  return { months: Number(t) }
}
