import regularUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url'
import boldUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url'
import { buildPdf } from './pdfReport.js'
import { buildFilename, triggerDownload } from './report.js'
import { latestAssetPhotos, photoUrl } from './api.js'
import { entitledTeam } from './entitlements.js'

// The browser's half of the PDF report: the fonts, fetched once and only when a
// PDF is made, then the download. The build's own files, so the service worker
// keeps them and a PDF can be made with no signal.

let fonts = null
const bytesOf = async url => new Uint8Array(await (await fetch(url)).arrayBuffer())
const loadFonts = async () => (fonts ??= { regular: await bytesOf(regularUrl), bold: await bytesOf(boldUrl) })

/**
 * The newest label photo of each item, as bytes by item id (D1c). They're in the
 * team's private photo folder, so this needs a connection and a team. Without
 * either, or if any of it fails, the PDF goes without photos, and `missing` says
 * so: a report is never held up for its photos.
 */
async function labelPhotos(assets) {
  const teamId = entitledTeam()
  const ids = (assets ?? []).map(a => a.id)
  if (!teamId || !ids.length) return { photos: {}, missing: false }
  if (navigator.onLine === false) return { photos: {}, missing: true }
  try {
    const latest = await latestAssetPhotos(teamId, ids)
    const photos = {}
    for (const [assetId, photo] of Object.entries(latest)) {
      const response = await fetch(await photoUrl(photo.path))
      if (response.ok) photos[assetId] = new Uint8Array(await response.arrayBuffer())
    }
    return { photos, missing: false }
  } catch {
    return { photos: {}, missing: true }
  }
}

/**
 * Builds the PDF report: its bytes, its filename, and whether label photos had to
 * be left out for want of a connection. Sending a report (D2) uses this too.
 */
export async function makePdf({ client, location, visit, rooms, revision, reportTitle, settings, assets, showLogo, layout }) {
  const { photos, missing } = await labelPhotos(assets)
  const bytes = await buildPdf({ client, location, visit, rooms, revision, reportTitle, settings, assets, showLogo, layout, photos, fonts: await loadFonts() })
  const filename = buildFilename(client, visit, revision, reportTitle).replace(/\.xlsx$/, '.pdf')
  return { bytes, filename, photosMissing: missing }
}

/** Builds the PDF report and downloads it. */
export async function downloadPdf(report) {
  const { bytes, filename, photosMissing } = await makePdf(report)
  triggerDownload(new Blob([bytes], { type: 'application/pdf' }), filename)
  return { filename, photosMissing }
}
