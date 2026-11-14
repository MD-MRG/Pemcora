// Making a photo small enough to upload: at most 1600 px on its long edge, as a
// JPEG at about 70% quality, the size the PDF report embeds (build plan D1). A
// phone's camera photo goes from several megabytes to a few hundred kilobytes.
//
// A room photo (0022) also keeps a full-quality copy, for download: the best
// JPEG that fits the evidence bucket (JPEG, PNG or WebP, up to 10 MB).

export const LONG_EDGE = 1600
export const QUALITY = 0.7
export const BUCKET_LIMIT = 10 * 1024 * 1024

const UNREADABLE = { ok: false, error: 'That photo couldn\'t be read. Try taking it again.' }

// The photo, turned the way the camera held it, from its own orientation tag.
async function decode(file) {
  if (!file?.type?.startsWith('image/')) return { ok: false, error: 'That file isn\'t a photo.' }
  try {
    return { ok: true, image: await createImageBitmap(file, { imageOrientation: 'from-image' }) }
  } catch {
    return UNREADABLE
  }
}

// The image as a JPEG, at most `longEdge` px on its long edge.
async function encode(image, longEdge, quality) {
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
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
  return blob ? { blob, width, height } : null
}

/**
 * @returns {Promise<{ ok: true, blob: Blob, width: number, height: number } | { ok: false, error: string }>}
 */
export async function shrinkPhoto(file, { longEdge = LONG_EDGE, quality = QUALITY } = {}) {
  const read = await decode(file)
  if (!read.ok) return read
  const made = await encode(read.image, longEdge, quality)
  read.image.close?.()
  return made ? { ok: true, ...made } : UNREADABLE
}

/**
 * The best full-quality JPEG of a photo that fits the bucket. A JPEG already
 * under the limit is kept exactly as it was taken. Anything else (a PNG, WebP or
 * HEIC, or a JPEG over 10 MB) is made a JPEG at full resolution and high
 * quality, or, if that still doesn't fit, the largest that does. `reduced` says
 * when it had to give up resolution or quality to fit.
 *
 * @returns {Promise<{ ok: true, blob: Blob, reduced: boolean } | { ok: false, error: string }>}
 */
export async function fullQualityJpeg(file, { limit = BUCKET_LIMIT } = {}) {
  if (file?.type === 'image/jpeg' && file.size <= limit) return { ok: true, blob: file, reduced: false }
  const read = await decode(file)
  if (!read.ok) return read
  const { image } = read
  const full = Math.max(image.width, image.height)
  try {
    // Full resolution first, a little less quality next, then smaller by steps.
    const tries = [
      [full, 0.92],
      [full, 0.85],
      ...[0.85, 0.7, 0.6, 0.5, 0.4, 0.3].map(f => [Math.round(full * f), 0.85]),
    ]
    let last = null
    for (const [i, [edge, quality]] of tries.entries()) {
      last = await encode(image, edge, quality)
      if (!last) return UNREADABLE
      if (last.blob.size <= limit) return { ok: true, blob: last.blob, reduced: i > 0 }
    }
    // A photo so large that a third of it still won't fit: as small as it gets.
    return { ok: true, blob: (await encode(image, LONG_EDGE, 0.85))?.blob ?? last.blob, reduced: true }
  } finally {
    image.close?.()
  }
}
