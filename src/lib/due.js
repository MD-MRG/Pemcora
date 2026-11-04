// The Due page's rules (build plan C4): due_list()'s rows, grouped and put into
// words. Pure, so they run in Node as well.

import { WORKFLOWS } from '../data/packs/index.js'
import { assetTypeLabel } from '../data/packs/shared/assetTypes.js'
import { localDate, showDate } from './equipment.js'

// In the order the page shows them (2.8).
export const DUE_GROUPS = [
  { kind: 'overdue', title: 'Overdue' },
  { kind: 'due', title: 'Due in the next 60 days' },
  { kind: 'not_done_yet', title: 'Not done yet' },
  { kind: 'expiring', title: 'Alarms expiring in the next 3 months' },
]

/** The rows of each group, for one client or all, leaving out groups with none. */
export const groupDue = (rows, clientId = '') =>
  DUE_GROUPS.map(g => ({
    ...g,
    rows: (rows ?? []).filter(r => r.kind === g.kind && (!clientId || r.clientId === clientId)),
  })).filter(g => g.rows.length)

/** The clients with anything on the list, by name, each once. */
export const clientsIn = rows =>
  [...new Map((rows ?? []).map(r => [r.clientId, r.clientName])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))

const byId = new Map(WORKFLOWS.map(w => [w.id, w]))

/** What a row is: the check's page name ("QLD smoke alarms"), or the item's name. */
export function dueTitle(row) {
  if (row.kind === 'expiring') return row.label || assetTypeLabel(row.obligation)
  return byId.get(row.obligation)?.nav.label ?? row.label ?? row.obligation
}

// Whole days from one date column to another.
const utc = date => {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
const days = (from, to) => Math.round((utc(to) - utc(from)) / 86400000)

const inDays = n => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`)

/** When, in words: "Due 3/10/2026 · 31 days overdue", "Expires 1/1/2027". */
export function whenText(row, today = localDate()) {
  if (row.kind === 'not_done_yet') return 'No visit yet'
  if (!row.dueOn) return ''
  const n = days(today, row.dueOn)
  if (row.kind === 'expiring') {
    return n <= 0 ? `Expired ${showDate(row.dueOn)}` : `Expires ${showDate(row.dueOn)} · ${inDays(n)}`
  }
  if (n < 0) return `Was due ${showDate(row.dueOn)} · ${-n} day${n === -1 ? '' : 's'} overdue`
  return `Due ${showDate(row.dueOn)} · ${inDays(n)}`
}

/** "Last done 3/11/2025", for a check that has been. */
export const lastDoneText = row => (row.lastDoneOn ? `Last done ${showDate(row.lastDoneOn)}` : '')
