// The report link `#/r/<token>` (build plan D3): reading the token from the
// address, and what the page says about a report, from what report_preview()
// returns. Pure, so it runs in Node too.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether the address is a report link at all, valid or not. */
export const isReportLink = hash => /^#\/r(\/|$)/.test(hash ?? '')

/** The link's token, or null when there isn't a well-formed one to ask about. */
export function reportTokenFrom(hash) {
  const m = /^#\/r\/([^/?#]+)\/?$/.exec(hash ?? '')
  if (!m) return null
  let token
  try {
    token = decodeURIComponent(m[1])
  } catch {
    return null
  }
  return UUID.test(token) ? token.toLowerCase() : null
}

const line = parts => parts.map(p => String(p ?? '').trim()).filter(Boolean)

/** "10 Smith St, Toowong QLD 4066" from the address the database copied. */
export function siteLine(site) {
  const s = site ?? {}
  const place = line([s.suburb || s.city, s.state, s.postcode]).join(' ')
  return line([s.address, place]).join(', ')
}

// "2026-11-06" → "6 November 2026", read as the date it is, wherever the reader is.
export function longDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(day ?? '')) return ''
  const at = new Date(`${day.slice(0, 10)}T00:00:00Z`)
  return at.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * What the page shows of a report whose link works. Everything comes from the
 * row report_preview() returned: the business and the sign-off as the database
 * wrote them, the rest as the snapshot keeps them.
 */
export function reportSummary(preview) {
  const snap = preview?.snapshot ?? {}
  const company = snap.provider?.company ?? {}
  const signoff = snap.signoff ?? null
  const issues = [
    ...(snap.site?.failed ?? []).map(f => ({ where: f.item || 'Whole site', ...f })),
    ...(snap.rooms ?? []).flatMap(r =>
      (r.failed ?? []).map(f => ({ where: r.name || 'A room', ...f })),
    ),
  ].map(f => ({
    where: f.where,
    label: f.label ?? '',
    note: f.note ?? '',
    mustReplace: Boolean(f.mustReplace),
  }))

  return {
    business: company.name || preview?.provider || snap.provider?.name || '',
    contact: line([
      company.licence_number && `Licence ${company.licence_number}`,
      company.rec_number && `REC ${company.rec_number}`,
      company.phone,
      company.email,
    ]),
    check: snap.reportTitle || preview?.workflow || 'Report',
    revision: snap.revision > 1 ? snap.revision : null,
    site: siteLine(preview?.site),
    client: snap.client ?? '',
    completedOn: longDate(preview?.completedOn),
    outcome:
      preview?.outcome === 'compliant' ? 'Compliant' : preview?.outcome ? 'Non-compliant' : '',
    signedBy: signoff?.technician
      ? line([
          signoff.technician,
          signoff.licence_number && `licence ${signoff.licence_number}`,
        ]).join(', ')
      : '',
    technician: snap.technician ?? '',
    issues,
    hasFile: Boolean(preview?.hasFile),
  }
}

// ── Saving it (D3c) ──────────────────────────────────────────────────────────

// A report being saved, remembered on this device while its new account is
// confirmed: the confirmation link opens the app, not the report, and this is
// how it gets back there. Kept a week at most, and used once.
const PENDING = 'pemcora.pendingReport'
const WEEK = 7 * 24 * 60 * 60 * 1000

export function rememberReport(token, storage = globalThis.localStorage) {
  try {
    storage?.setItem(PENDING, JSON.stringify({ token, at: Date.now() }))
  } catch {
    /* private browsing: they'll open the email's link again */
  }
}

/** The report to go back to, once: reading it forgets it. */
export function takePendingReport(storage = globalThis.localStorage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage?.getItem(PENDING) ?? 'null')
    storage?.removeItem(PENDING)
    if (!saved || now - saved.at > WEEK || !UUID.test(saved.token ?? '')) return null
    return saved.token
  } catch {
    return null
  }
}

/** "Jane Citizen's properties", from the address signed in with, for a new account's name. */
export function defaultAccountName(email) {
  const words = String(email ?? '')
    .split('@')[0]
    .split('+')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ')
  return words ? `${words}'s properties` : 'My properties'
}

/** An account's properties, by address, each with its owner. */
export function propertyChoices(clients) {
  return (clients ?? [])
    .flatMap(c => (c.locations ?? []).map(l => ({ id: l.id, label: siteLine(l), owner: c.name })))
    .sort((a, b) => a.label.localeCompare(b.label))
}
