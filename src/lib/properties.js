// A landlord's or agency's properties (build plan D4c), each with what is due
// there and the reports filed under it. Pure, so it runs in Node too.
//
//   clients  the account's own, on the device: { id, name, locations: [...] }
//   items    its compliance_items rows: what each property owes, and when
//   reports  received_reports() rows (0013)

import { longDate, receivedAsPreview, reportSummary, siteLine } from './reportLink.js'

export const SOON_DAYS = 60

const dayOf = d => (d ? String(d).slice(0, 10) : null)
const addDays = (day, n) => {
  const at = new Date(`${day}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + n)
  return at.toISOString().slice(0, 10)
}

/** Where a check stands: overdue, due soon, fine, or not on record yet. */
export function checkState(nextDue, today) {
  const due = dayOf(nextDue)
  if (!due) return 'unknown'
  if (due < today) return 'overdue'
  if (due <= addDays(today, SOON_DAYS)) return 'soon'
  return 'ok'
}

const RANK = { overdue: 0, soon: 1, ok: 2, unknown: 3 }

export function propertyCards(
  clients,
  items,
  reports,
  today = new Date().toISOString().slice(0, 10),
) {
  const byPlace = new Map()
  for (const c of clients ?? []) {
    for (const l of c.locations ?? []) {
      byPlace.set(l.id, {
        id: l.id,
        clientId: c.id,
        owner: c.name,
        address: siteLine(l),
        checks: [],
        reports: [],
        selfFiling: [],
      })
    }
  }

  for (const item of items ?? []) {
    const card = byPlace.get(item.location_id)
    if (!card || item.active === false) continue
    const state = checkState(item.next_due_on, today)
    card.checks.push({
      id: item.id,
      label: item.label,
      intervalMonths: item.interval_months,
      nextDue: longDate(dayOf(item.next_due_on)),
      lastDone: longDate(dayOf(item.last_done_on)),
      state,
      hasCertificate: Boolean(item.evidence_path),
      evidencePath: item.evidence_path ?? null,
      byReport: Boolean(item.satisfied_by),
    })
  }

  for (const r of reports ?? []) {
    const card = byPlace.get(r.recipient_location_id)
    if (!card) continue
    const s = reportSummary(receivedAsPreview(r))
    card.reports.push({
      id: r.id,
      check: s.check,
      business: s.business,
      completedOn: s.completedOn,
      day: dayOf(r.completed_on) ?? '',
      outcome: s.outcome,
      hasFile: Boolean(r.has_file),
      filePath: r.file_path,
    })
    // One line per business whose site files here by itself, named by its latest report.
    if (r.files_itself && !card.selfFiling.some(f => f.business === s.business)) {
      card.selfFiling.push({ business: s.business, deliveryId: r.id })
    }
  }

  return [...byPlace.values()]
    .map(card => ({
      ...card,
      checks: card.checks.sort(
        (a, b) => RANK[a.state] - RANK[b.state] || a.label.localeCompare(b.label),
      ),
      reports: card.reports.sort((a, b) => b.day.localeCompare(a.day)),
    }))
    .sort((a, b) => a.address.localeCompare(b.address))
}

/** The owners already in the account, for the new property form. */
export const ownersOf = clients =>
  [...new Set((clients ?? []).map(c => c.name).filter(Boolean))].sort((a, b) => a.localeCompare(b))
