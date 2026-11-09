/**
 * Whether a report link may have its PDF, decided from the delivery's row. No
 * Deno and no network, so tests/report-file.mjs runs it in Node. Plain
 * JavaScript, which Deno imports as it is.
 *
 * The same cases as report_preview() (0007), in the same order: a report saved
 * to an account is that account's now, so the link asks them to sign in; past
 * its 90 days the link has expired; otherwise the link works. Only then is a
 * file link made.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The plan's "a few minutes" (2.10): long enough to open it, too short to pass on.
export const LINK_SECONDS = 300

// What the function reads, and nothing more: never the recipient's address.
export const COLUMNS = 'file_path, link_expires_at, claimed_at, recipient_team_id'

export function fileAccess(row, now = Date.now()) {
  if (!row) return { status: 404, body: { status: 'invalid', error: "That report link isn't valid." } }
  if (row.claimed_at || row.recipient_team_id) {
    return { status: 403, body: { status: 'saved', error: 'This report has been saved to a Pemcora account. Sign in to download it.' } }
  }
  const expires = Date.parse(row.link_expires_at ?? '')
  if (Number.isNaN(expires) || expires <= now) {
    return { status: 410, body: { status: 'expired', error: 'This link has expired.' } }
  }
  if (!row.file_path) return { status: 404, body: { status: 'no-file', error: 'This report has no PDF.' } }
  return { ok: true, path: row.file_path }
}
