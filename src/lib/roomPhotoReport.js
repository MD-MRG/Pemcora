import { photoUrls, roomPhotosOf } from './api.js'
import { entitledTeam } from './entitlements.js'
import { shrinkPhoto } from './photo.js'
import { photosAtVisit } from './reportSnapshot.js'

// A report's room photos (0022), fetched in the browser: the list for the
// snapshot and the Excel export, and for the PDF the photos themselves, made
// smaller again. They're in the team's private photo folder, so this needs a
// connection and a team. Without either, or if any of it fails, the report goes
// without them and `missing` says so: a report is never held up for its photos.

export const PDF_EDGE = 1000
export const PDF_QUALITY = 0.65
// What a report's photos may add up to. The reports bucket takes 10 MB a PDF,
// and the rest of the report and the label photos need some of it.
export const PDF_BUDGET = 7 * 1024 * 1024
const SMALLEST_EDGE = 480

const nothing = missing => ({ photos: {}, bytes: {}, missing })

async function shrinkAll(originals, longEdge) {
  const bytes = {}
  let total = 0
  for (const [id, blob] of Object.entries(originals)) {
    const small = await shrinkPhoto(blob, { longEdge, quality: PDF_QUALITY })
    // One the browser can't redraw still goes, as it is: it's already a JPEG.
    const out = small.ok ? new Uint8Array(await small.blob.arrayBuffer()) : new Uint8Array(await blob.arrayBuffer())
    bytes[id] = out
    total += out.length
  }
  return { bytes, total }
}

/**
 * The visit's rooms' photos: { photos: { roomId: [photo] }, bytes: { photoId:
 * Uint8Array }, missing }. Only photos added by the day the visit was completed,
 * which is all a report shows. `withBytes` fetches the photos too, at about
 * 1000 px, smaller still if a big site's photos would make the PDF too large.
 */
export async function roomPhotosForReport(rooms, visit, { withBytes = false, budget = PDF_BUDGET } = {}) {
  const teamId = entitledTeam()
  const roomIds = (rooms ?? []).map(r => r.id).filter(Boolean)
  if (!teamId || !roomIds.length) return nothing(false)
  if (navigator.onLine === false) return nothing(true)

  let photos
  try {
    const all = await roomPhotosOf(teamId, roomIds)
    photos = Object.fromEntries(
      Object.entries(all)
        .map(([roomId, list]) => [roomId, photosAtVisit(list, visit)])
        .filter(([, list]) => list.length),
    )
  } catch {
    return nothing(true)
  }
  if (!withBytes) return { photos, bytes: {}, missing: false }

  const wanted = Object.values(photos).flat()
  if (!wanted.length) return { photos, bytes: {}, missing: false }
  let missing = false
  const originals = {}
  try {
    const links = await photoUrls(wanted.map(p => p.path))
    for (const photo of wanted) {
      try {
        const response = await fetch(links[photo.path])
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        originals[photo.id] = new Blob([await response.arrayBuffer()], { type: 'image/jpeg' })
      } catch {
        missing = true
      }
    }
  } catch {
    return { photos, bytes: {}, missing: true }
  }

  let made = await shrinkAll(originals, PDF_EDGE)
  if (made.total > budget) {
    // Smaller in proportion: a photo's size goes roughly with its area.
    const edge = Math.max(SMALLEST_EDGE, Math.floor(PDF_EDGE * Math.sqrt(budget / made.total)))
    made = await shrinkAll(originals, edge)
  }
  return { photos, bytes: made.bytes, missing }
}
