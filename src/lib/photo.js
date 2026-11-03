// Making a photo small enough to upload: at most 1600 px on its long edge, as a
// JPEG at about 70% quality, the size the PDF report embeds (build plan D1). A
// phone's camera photo goes from several megabytes to a few hundred kilobytes.

export const LONG_EDGE = 1600
export const QUALITY = 0.7

/**
 * @returns {Promise<{ ok: true, blob: Blob, width: number, height: number } | { ok: false, error: string }>}
 */
export async function shrinkPhoto(file, { longEdge = LONG_EDGE, quality = QUALITY } = {}) {
  if (!file?.type?.startsWith('image/')) return { ok: false, error: 'That file isn\'t a photo.' }
  let image
  try {
    // Turned the way the camera held it, from the photo's own orientation tag.
    image = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return { ok: false, error: 'That photo couldn\'t be read. Try taking it again.' }
  }
  const scale = Math.min(1, longEdge / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  // A transparent image comes out white, not black, as a JPEG has no transparency.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)
  image.close?.()
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) return { ok: false, error: 'That photo couldn\'t be read. Try taking it again.' }
  return { ok: true, blob, width, height }
}
