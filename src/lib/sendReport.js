import { buildReportSnapshot } from './reportSnapshot.js'
import { makePdf } from './pdfDownload.js'
import { roomPhotosForReport } from './roomPhotoReport.js'
import { sendReportTo, uploadReportPdf } from './api.js'
import { entitledTeam } from './entitlements.js'
import { isSupabaseConfigured } from './supabase.js'

// Sending a report (D2, build plan 2.10): the PDF made in the browser goes to the
// team's report folder, then the deliver-report function records the delivery
// and emails the link. The database fills in the address, the business and the
// sign-off itself, and refuses over the daily cap or with a note unfinished.

/** Whether this device can send reports at all: a backend and a signed-in team. */
export const canSendReports = () => isSupabaseConfigured && Boolean(entitledTeam())

export const looksLikeEmail = s => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(s ?? '').trim())

/** Where a report's snapshot still has a note waiting for its timeframe. */
export function unfinishedIn(snapshot) {
  const where = []
  if ((snapshot?.site?.failed ?? []).some(f => f.unfinished)) where.push('the whole-site step')
  for (const room of snapshot?.rooms ?? []) {
    if ((room.failed ?? []).some(f => f.unfinished)) where.push(room.name || 'a room')
  }
  return where
}

const refused = (message, hint = null) => Object.assign(new Error(message), { hint })

/**
 * Makes the report's PDF, puts it in the team's folder and sends it to `email`.
 * Returns what deliver-report says ({ id, link, emailed, email, expiresAt }),
 * the PDF's filename, and whether any of its label or room photos were left out.
 *
 * Refuses before anything leaves the device when there's no team or no signal,
 * or when a note still says [timeframe]: a sent report can't be changed. The
 * database refuses the last one too; this is so it's said before the upload.
 */
export async function sendReport({ email, ...report }) {
  const teamId = canSendReports() ? entitledTeam() : null
  if (!teamId) throw refused('Sending a report needs a signed-in team.')
  if (navigator.onLine === false) throw refused('Sending a report needs a connection.', 'offline')
  if (!looksLikeEmail(email)) throw refused('That is not an email address.')

  const { client, visit, rooms, assets, revision, reportTitle } = report
  const where = unfinishedIn(buildReportSnapshot({ client, visit, rooms, assets, revision, reportTitle }))
  if (where.length) {
    throw refused(
      `A note in ${where.join(', ')} still says [timeframe]. Reopen the visit and fill it in, then send the report.`,
      'unfinished',
    )
  }

  // Fetched once: the snapshot keeps their descriptions, the PDF the photos.
  const roomPhotos = await roomPhotosForReport(rooms, visit, { withBytes: true })
  const snapshot = buildReportSnapshot({ client, visit, rooms, assets, revision, reportTitle, roomPhotos: roomPhotos.photos })
  const { bytes, filename, photosMissing } = await makePdf({ ...report, roomPhotos })
  const filePath = await uploadReportPdf(teamId, bytes)
  const sent = await sendReportTo({
    visitId: visit.id,
    email: email.trim(),
    snapshot,
    filePath,
    title: reportTitle ? `${reportTitle} report` : 'report',
  })
  return { ...sent, filename, photosMissing }
}
