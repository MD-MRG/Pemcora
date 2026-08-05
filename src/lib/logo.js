import { MAX_LOGO_BYTES } from './settingsStore.js'

// Reading an uploaded logo into something both the sidebar and the Excel
// report can use.
//
// ExcelJS embeds PNG and JPEG only — it cannot take an SVG. So an SVG is kept
// as-is for the screen (crisp at any size) and rasterised to PNG alongside it
// for the report. If rasterising fails the report falls back to text, which the
// page says out loud rather than silently dropping the logo.

const ACCEPTED = ['image/svg+xml', 'image/png', 'image/jpeg']

const readAsDataUrl = file =>
  new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = () => reject(new Error('Could not read that file.'))
    fr.readAsDataURL(file)
  })

// Draw an image onto a canvas at up to `maxPx` on its longest edge and return
// a PNG data URI. Data URIs don't taint the canvas, so this stays exportable.
function rasterise(src, maxPx = 480) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxPx / Math.max(img.width || 1, img.height || 1))
        const w = Math.max(1, Math.round((img.width || maxPx) * scale))
        const h = Math.max(1, Math.round((img.height || maxPx) * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/**
 * @returns {Promise<{ ok: true, logo: { src, reportSrc, name, type } }
 *                 | { ok: false, error: string }>}
 */
export async function readLogoFile(file) {
  if (!file) return { ok: false, error: 'No file chosen.' }
  if (!ACCEPTED.includes(file.type)) {
    return { ok: false, error: 'Use an SVG, PNG or JPG.' }
  }
  if (file.size > MAX_LOGO_BYTES) {
    return {
      ok: false,
      error: `That file is ${Math.round(file.size / 1024)} KB. Keep logos under ${MAX_LOGO_BYTES / 1024} KB — browser storage is shared with your job data.`,
    }
  }

  const src = await readAsDataUrl(file)
  // PNG and JPEG go into the report as-is; SVG needs rasterising first.
  const reportSrc = file.type === 'image/svg+xml' ? await rasterise(src) : src

  return { ok: true, logo: { src, reportSrc, name: file.name, type: file.type } }
}

// What the report can embed, if anything.
export function reportImage(logo) {
  const src = logo?.reportSrc
  if (!src) return null
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(src)
  return m ? { base64: m[2], extension: m[1] === 'jpeg' ? 'jpeg' : 'png' } : null
}
