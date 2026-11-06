import regularUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url'
import boldUrl from 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url'
import { buildPdf } from './pdfReport.js'
import { buildFilename, triggerDownload } from './report.js'

// The browser's half of the PDF report: the fonts, fetched once and only when a
// PDF is made, then the download. The build's own files, so the service worker
// keeps them and a PDF can be made with no signal.

let fonts = null
const bytesOf = async url => new Uint8Array(await (await fetch(url)).arrayBuffer())
const loadFonts = async () => (fonts ??= { regular: await bytesOf(regularUrl), bold: await bytesOf(boldUrl) })

/** Builds the PDF report and downloads it. Returns its filename. */
export async function downloadPdf({ client, location, visit, rooms, revision, reportTitle, settings, assets, showLogo, layout }) {
  const bytes = await buildPdf({ client, location, visit, rooms, revision, reportTitle, settings, assets, showLogo, layout, fonts: await loadFonts() })
  const filename = buildFilename(client, visit, revision, reportTitle).replace(/\.xlsx$/, '.pdf')
  triggerDownload(new Blob([bytes], { type: 'application/pdf' }), filename)
  return filename
}
