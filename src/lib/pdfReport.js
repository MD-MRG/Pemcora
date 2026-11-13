import { buildReportSnapshot } from './reportSnapshot.js'
import { reportImage } from './logo.js'
import { answerTone } from './testTypes.js'
import { addMonths } from './equipment.js'
import { assetTypePlural } from '../data/packs/shared/assetTypes.js'
import { WORKFLOWS } from '../data/packs/index.js'

// PDF report for a visit (build plan D1), laid out from the same snapshot as the
// Excel export and the copy a sent report keeps, so the three never disagree.
//
// Pure: no DOM. The fonts are handed in as bytes (pdfDownload.js loads them in
// the browser, the suites read them from disk), and pdf-lib loads only when a
// PDF is made, as ExcelJS does for a workbook.
//
// The fonts are DejaVu Sans (Bitstream Vera licence, free to embed). The PDF's
// own standard fonts can't print the "Ω", "—" and "·" these reports use. Only
// the characters a report uses are embedded.

const A4 = [595.28, 841.89]
const MARGIN = 42
const LINE = 1.3 // line height, as a multiple of the font size

const hex = h => [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
const COLOURS = {
  ink: hex('1F2933'),
  soft: hex('6A7683'),
  navy: hex('1B3A5C'),
  grey: hex('E5E7EB'),
  hair: hex('D9DDE2'),
  pass: hex('1E7A45'),
  fail: hex('C22E1C'),
  na: hex('7C8894'),
  white: [1, 1, 1],
}
const OUTCOME_TEXT = { compliant: 'Compliant', non_compliant: 'Non-compliant' }

// Characters a PDF can't draw as text, made safe: tabs and stray carriage returns.
const clean = s => String(s ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ')

/** Splits text into lines that fit `width`, breaking a word too long for a line. */
export function wrap(text, font, size, width) {
  const out = []
  for (const para of clean(text).split('\n')) {
    let line = ''
    for (const word of para.split(/ +/)) {
      const tryLine = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(tryLine, size) <= width) {
        line = tryLine
        continue
      }
      if (line) out.push(line)
      // A word wider than the line goes in pieces.
      let rest = word
      while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
        let n = rest.length - 1
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--
        out.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    out.push(line)
  }
  return out
}

// The Victorian check's certification, under the signature. A proposal, like the
// list: the electrician checks it before the pack ships.
export const ESV_DECLARATION =
  'I certify that this electrical safety check was carried out in accordance with section 4 of AS/NZS 3019, and that the results are as recorded in this report.'

const intervalOf = kind => WORKFLOWS.find(w => w.id === kind)?.interval?.months ?? null

/**
 * Builds the PDF and returns its bytes.
 *
 *   layout     'esv' for the Victorian electrical check, laid out as Energy Safe
 *              Victoria's report form is: sections A to F, then certification
 *              (D1b). Anything else, the layout every other workflow uses.
 *   location   the site, with its visits: the ESV layout reads the previous
 *              check's date and the smoke alarm check's from them
 *   showLogo   false for a team that isn't Pro once limits are on (2.4)
 *   photos     each item's label photo, as JPEG bytes by item id (D1c), already
 *              made small when it was taken (photo.js: 1600 px, about 70%)
 *   roomPhotos      each room's photos (0022), as { roomId: [{ id, caption,
 *                   takenAt }] }: the snapshot keeps those added by the day the
 *                   visit was completed
 *   roomPhotoBytes  their JPEG bytes by photo id, made small for the PDF
 *                   (roomPhotoReport.js: about 1000 px). One missing prints a
 *                   note in its place.
 *   fonts      { regular, bold }: DejaVu Sans, as bytes
 */
export async function buildPdf({
  client,
  location,
  visit,
  rooms,
  revision = 1,
  reportTitle = 'Preventative Maintenance',
  settings = null,
  assets = [],
  showLogo = true,
  layout = 'standard',
  photos = {},
  roomPhotos = {},
  roomPhotoBytes = {},
  fonts,
}) {
  const esv = layout === 'esv'
  const { PDFDocument, rgb } = await import('pdf-lib')
  const fontkit = (await import('@pdf-lib/fontkit')).default
  const colour = c => rgb(...c)

  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const regular = await doc.embedFont(fonts.regular, { subset: true })
  const bold = await doc.embedFont(fonts.bold, { subset: true })
  const company = settings?.company ?? {}
  doc.setTitle(`${reportTitle} — ${client?.name ?? ''}`)
  doc.setCreator('Pemcora')
  doc.setProducer('Pemcora')
  if (company.name) doc.setAuthor(company.name)

  const [W, H] = A4
  const inner = W - 2 * MARGIN
  let page
  let y

  const newPage = () => {
    page = doc.addPage(A4)
    y = H - MARGIN
  }
  // Room for `h` more points on this page, or a new one.
  const ensure = h => {
    if (y - h < MARGIN + 18) newPage()
  }
  const draw = (lines, { x = MARGIN, size = 10, font = regular, tint = COLOURS.ink } = {}) => {
    for (const line of lines) {
      page.drawText(line, { x, y: y - size, size, font, color: colour(tint) })
      y -= size * LINE
    }
  }
  const gap = (h = 6) => {
    y -= h
  }

  // A bar across the page: navy for a room or the whole site, grey for a section.
  const bar = (text, { navy = false } = {}) => {
    const size = navy ? 12 : 10
    const h = size * LINE + 8
    ensure(h + 24)
    page.drawRectangle({ x: MARGIN, y: y - h, width: inner, height: h, color: colour(navy ? COLOURS.navy : COLOURS.grey) })
    page.drawText(clean(text), { x: MARGIN + 6, y: y - h + 6, size, font: bold, color: colour(navy ? COLOURS.white : COLOURS.ink) })
    y -= h + 4
  }

  // Two columns: what was asked, and what was found.
  const LABEL_W = inner * 0.56
  const ANSWER_X = MARGIN + LABEL_W + 10
  const ANSWER_W = inner - LABEL_W - 10
  const row = (label, answer, { tone = '', labelFont = regular } = {}) => {
    const size = 9.5
    const left = wrap(label, labelFont, size, LABEL_W)
    const right = wrap(answer ?? '', tone === 'pass' || tone === 'fail' ? bold : regular, size, ANSWER_W)
    const h = Math.max(left.length, right.length) * size * LINE + 4
    ensure(h)
    const top = y
    draw(left, { size, font: labelFont })
    y = top
    draw(right, {
      x: ANSWER_X,
      size,
      font: tone === 'pass' || tone === 'fail' ? bold : regular,
      tint: tone === 'fail' ? COLOURS.fail : tone === 'pass' ? COLOURS.pass : tone === 'na' ? COLOURS.na : COLOURS.ink,
    })
    y = top - h
    page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: W - MARGIN, y: y + 2 }, thickness: 0.4, color: colour(COLOURS.hair) })
  }
  const result = test => row(test.label, test.answer, { tone: test.fail ? 'fail' : answerTone(test, test.value) })
  const paragraph = (text, { size = 9.5, tint = COLOURS.ink, font = regular } = {}) => {
    const lines = wrap(text, font, size, inner)
    for (const line of lines) {
      ensure(size * LINE)
      draw([line], { size, tint, font })
    }
  }

  newPage()

  // ── Who it's from ───────────────────────────────────────────────────────
  const image = showLogo ? reportImage(settings?.logoFull ?? settings?.logoCollapsed) : null
  if (image) {
    try {
      const logo = image.extension === 'png' ? await doc.embedPng(image.base64) : await doc.embedJpg(image.base64)
      const scale = Math.min(170 / logo.width, 50 / logo.height, 1)
      page.drawImage(logo, { x: MARGIN, y: y - logo.height * scale, width: logo.width * scale, height: logo.height * scale })
      y -= logo.height * scale + 8
    } catch {
      /* an unusable image must not cost the client their report */
    }
  }
  if (company.name) draw(wrap(company.name, bold, 13, inner), { size: 13, font: bold, tint: COLOURS.navy })
  const contact = [
    company.abn && `ABN ${company.abn}`,
    company.licence_number && `Licence ${company.licence_number}`,
    company.rec_number && `REC ${company.rec_number}`,
    company.phone,
    company.email,
  ]
    .filter(Boolean)
    .join('  ·  ')
  if (contact) draw(wrap(contact, regular, 9, inner), { size: 9, tint: COLOURS.soft })
  gap(10)

  // ── What it is ──────────────────────────────────────────────────────────
  draw(wrap(reportTitle, bold, 17, inner), { size: 17, font: bold })
  // A revised report has to announce itself, or the client can't tell two copies apart.
  if (revision > 1) draw([`Revision ${revision}`], { size: 11, font: bold, tint: COLOURS.fail })
  gap(6)
  const address = [location?.address, location?.suburb, location?.city, location?.state, location?.postcode].filter(Boolean).join(', ')
  const details = [
    ['Client', client?.name ?? ''],
    ['Address', address],
    ['Technician', visit?.technician ?? ''],
    ['Visit started', (visit?.startedAt ?? '').slice(0, 10)],
    ['Visit completed', (visit?.completedAt ?? '').slice(0, 10)],
    // Only a check that is signed off has these.
    ...(visit?.outcome ? [['Outcome', OUTCOME_TEXT[visit.outcome] ?? visit.outcome]] : []),
  ]
  // The ESV form puts these in section A and the certification instead.
  if (!esv) {
    for (const [k, v] of details) {
      row(k, v, { labelFont: bold, tone: k === 'Outcome' ? (visit.outcome === 'compliant' ? 'pass' : 'fail') : '' })
    }
  }
  gap(12)

  const snapshot = buildReportSnapshot({ client, visit, rooms, assets, revision, reportTitle, roomPhotos })

  // Fails and their notes, then the comments: the close of a room and of the
  // whole site alike.
  const notesAndComments = ({ failed, comments }) => {
    bar('Troubleshooting')
    if (failed.length === 0) paragraph('No issues identified.', { tint: COLOURS.soft })
    defects(failed)
    gap(6)
    bar('Comments')
    paragraph(comments || '—', { tint: comments ? COLOURS.ink : COLOURS.soft })
    gap(14)
  }

  // One whole-site section: its tests, or each item and its tests.
  const siteSection = section => {
    bar(section.label)
    if (section.scope !== 'item') {
      section.tests.forEach(result)
    } else if (section.items.length === 0) {
      paragraph('No items recorded', { tint: COLOURS.soft })
    } else {
      for (const item of section.items) {
        ensure(40)
        draw([item.room ? `${item.label} (${item.room})` : item.label], { size: 10, font: bold })
        item.tests.forEach(result)
        gap(4)
      }
    }
    gap(8)
  }
  const defects = failed => {
    for (const f of failed) {
      const note = f.mustReplace ? [f.note, 'Has to be replaced'].filter(Boolean).join(' — ') : f.note
      row(f.item ? `${f.item} — ${f.label}` : f.label, note, { tone: 'fail' })
    }
  }

  // ── The whole site ──────────────────────────────────────────────────────
  if (snapshot.site && !esv) {
    bar('Whole site', { navy: true })
    snapshot.site.sections.forEach(siteSection)
    notesAndComments(snapshot.site)
  }

  // ── Sections A to F, as ESV's form has them (D1b) ───────────────────────
  // The site's other visits say when this check was last done, and when its
  // smoke alarms are next due.
  const done = (kind, before) =>
    (location?.visits ?? [])
      .filter(v => v.kind === kind && v.completedAt && v.id !== visit?.id && (!before || v.completedAt < before))
      .map(v => v.completedAt.slice(0, 10))
      .sort()
      .pop() ?? null
  if (esv) {
    const previous = done(visit?.kind, visit?.startedAt ?? visit?.completedAt)
    bar('A. Installation', { navy: true })
    row('Address', address, { labelFont: bold })
    row('Client', client?.name ?? '', { labelFont: bold })
    row('Date of this check', (visit?.completedAt ?? visit?.startedAt ?? '').slice(0, 10), { labelFont: bold })
    row('Date of the previous check', previous ?? 'None on record', { labelFont: bold })
    gap(10)
    for (const section of snapshot.site?.sections ?? []) {
      if (/^F\./.test(section.label)) {
        // What the electrician wrote, then each defect with what was done.
        siteSection(section)
        y += 8
        if (snapshot.site.failed.length) defects(snapshot.site.failed)
        else paragraph('No defects found.', { tint: COLOURS.soft })
        if (snapshot.site.comments) {
          gap(4)
          paragraph(snapshot.site.comments)
        }
        gap(10)
        continue
      }
      siteSection(section)
      if (/^E\./.test(section.label)) {
        // From this site's smoke alarm check, which has its own report.
        const smoke = done('vic_smoke_alarm')
        y += 8
        row('Next smoke alarm check due', smoke ? addMonths(smoke, intervalOf('vic_smoke_alarm') ?? 12) : 'No smoke alarm check on record')
        gap(8)
      }
    }
  }

  // An item's label photo, under its details, kept on one page.
  const labelPhoto = async item => {
    const bytes = photos[item.id]
    if (!bytes) return
    let image
    try {
      // A copy of its own: pdf-lib reads from the start of the bytes' memory, which
      // isn't where a Node Buffer, or any other view into shared memory, begins.
      image = await doc.embedJpg(Uint8Array.from(bytes))
    } catch {
      return // a photo that can't be read must not cost the client their report
    }
    const scale = Math.min(220 / image.width, 160 / image.height, 1)
    const h = image.height * scale
    ensure(h + 24)
    gap(6)
    page.drawImage(image, { x: MARGIN, y: y - h, width: image.width * scale, height: h })
    y -= h + 2
    draw([`Label photo — ${item.label}`], { size: 8, tint: COLOURS.soft })
  }

  // ── Equipment ───────────────────────────────────────────────────────────
  if (snapshot.equipment.length) {
    bar('Equipment', { navy: true })
    const day = (visit?.completedAt ?? new Date().toISOString()).slice(0, 10)
    const date = iso => (iso ?? '').slice(0, 10)
    for (const type of [...new Set(snapshot.equipment.map(e => e.assetType))]) {
      const plural = assetTypePlural(type)
      bar(plural.charAt(0).toUpperCase() + plural.slice(1))
      for (const item of snapshot.equipment.filter(e => e.assetType === type)) {
        const gone = item.status === 'in place' ? '' : ` (${item.status})`
        ensure(40)
        draw([(item.room ? `${item.label} (${item.room})` : item.label) + gone], { size: 10, font: bold })
        for (const [label, text] of item.details) row(label, text)
        const makeModel = [item.make, item.model].filter(Boolean).join(' ')
        if (makeModel) row('Make and model', makeModel)
        if (item.serial) row('Serial number', item.serial)
        if (item.installedOn) row('Installed', item.installedOn)
        if (item.expiresOn) {
          const expired = item.expiresOn <= day && !gone
          row('Expires', expired ? `${item.expiresOn} (expired)` : item.expiresOn, { tone: expired ? 'fail' : '' })
        }
        if (item.status === 'replaced') row('Replaced', date(item.removedAt))
        else if (item.status === 'removed') row('Removed', date(item.removedAt))
        if (item.replaces) row('Put in', `${date(item.createdAt)}, replacing ${item.replaces}`)
        await labelPhoto(item)
        gap(4)
      }
      gap(8)
    }
    gap(6)
  }

  // A room's photos (0022), each with its description and the day it was
  // added beside it, kept on one page. One that couldn't be fetched says so
  // in its place.
  const PHOTO_W = 230
  const PHOTO_H = 172
  const roomPhotoList = async photos => {
    // The heading stays with its first photo.
    ensure(PHOTO_H + 50)
    bar('Photos')
    const textX = MARGIN + PHOTO_W + 12
    const textW = inner - PHOTO_W - 12
    for (const photo of photos) {
      let image = null
      const bytes = roomPhotoBytes[photo.id]
      if (bytes) {
        try {
          image = await doc.embedJpg(Uint8Array.from(bytes)) // a copy of its own, as for a label photo
        } catch {
          image = null // a photo that can't be read must not cost the client their report
        }
      }
      const scale = image ? Math.min(PHOTO_W / image.width, PHOTO_H / image.height, 1) : 0
      const h = image ? image.height * scale : 48
      const lines = wrap(photo.caption || 'No description', regular, 9.5, textW)
      const textH = (lines.length + 1) * 9.5 * LINE
      const rowH = Math.max(h, textH) + 10
      ensure(rowH)
      const top = y
      if (image) {
        page.drawImage(image, { x: MARGIN, y: top - h, width: image.width * scale, height: h })
      } else {
        page.drawRectangle({ x: MARGIN, y: top - h, width: PHOTO_W, height: h, borderColor: colour(COLOURS.hair), borderWidth: 0.8 })
        page.drawText('Photo not included in this copy', { x: MARGIN + 8, y: top - h / 2 - 3, size: 8.5, font: regular, color: colour(COLOURS.soft) })
      }
      draw(lines, { x: textX, size: 9.5, tint: photo.caption ? COLOURS.ink : COLOURS.soft })
      draw([`Added ${photo.addedOn}`], { x: textX, size: 8.5, tint: COLOURS.soft })
      y = top - rowH
    }
  }

  // ── Each room ───────────────────────────────────────────────────────────
  for (const [i, room] of snapshot.rooms.entries()) {
    bar(`Room ${i + 1}: ${room.name || '(unnamed)'}`, { navy: true })
    row('Floor', room.floor || '', { labelFont: bold })
    if (room.planNumber) row('Floor plan no.', room.planNumber, { labelFont: bold })
    gap(6)
    if (!room.tested) {
      paragraph('Not tested during this visit', { tint: COLOURS.soft })
      if (room.photos) {
        gap(8)
        await roomPhotoList(room.photos)
      }
      gap(14)
      continue
    }
    for (const section of room.sections) {
      bar(section.label)
      section.tests.forEach(result)
      gap(8)
    }
    notesAndComments(room)
    if (room.photos) {
      await roomPhotoList(room.photos)
      gap(14)
    }
  }

  // ── Signed off, or for the ESV form, certified ──────────────────────────
  const signoff = visit?.signoff
  if (esv) {
    ensure(230)
    bar('Certification', { navy: true })
    const completed = (visit?.completedAt ?? '').slice(0, 10)
    const every = intervalOf(visit?.kind)
    row('Electrician', signoff?.technician || visit?.technician || '', { labelFont: bold })
    row('Business name', company.name ?? '', { labelFont: bold })
    row('REC number', company.rec_number ?? '', { labelFont: bold })
    row('Licence or registration number', signoff?.licence_number ?? '', { labelFont: bold })
    row('Inspection date', completed, { labelFont: bold })
    row('Next check due', completed && every ? addMonths(completed, every) : '', { labelFont: bold })
    if (visit?.outcome) {
      row('Outcome declared', OUTCOME_TEXT[visit.outcome] ?? visit.outcome, {
        labelFont: bold,
        tone: visit.outcome === 'compliant' ? 'pass' : 'fail',
      })
    }
    gap(6)
    paragraph(ESV_DECLARATION)
  } else if (signoff) {
    ensure(170)
    bar('Signed off', { navy: true })
    row('Name', signoff.technician ?? '', { labelFont: bold })
    if (signoff.licence_number) row('Licence or registration number', signoff.licence_number, { labelFont: bold })
    row('Signed', (signoff.signed_at ?? '').slice(0, 10), { labelFont: bold })
    if (visit.outcome) row('Outcome declared', OUTCOME_TEXT[visit.outcome] ?? visit.outcome, { labelFont: bold })
  }
  if (signoff?.signature) {
    // The signature pad's 600 × 180 box, drawn at about a third of its size,
    // kept on one page with its line.
    const scale = 0.36
    ensure(180 * scale + 30)
    gap(8)
    page.drawSvgPath(signoff.signature, {
      x: MARGIN,
      y,
      scale,
      borderColor: colour(COLOURS.ink),
      borderWidth: 1.6 / scale,
    })
    y -= 180 * scale
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + 600 * scale, y }, thickness: 0.6, color: colour(COLOURS.soft) })
    gap(4)
    draw(['Signature'], { size: 8, tint: COLOURS.soft })
  }

  // ── Every page says what it belongs to ──────────────────────────────────
  const pages = doc.getPages()
  const foot = [reportTitle, client?.name, revision > 1 ? `Revision ${revision}` : null].filter(Boolean).join(' · ')
  pages.forEach((p, i) => {
    const size = 8
    const right = `Page ${i + 1} of ${pages.length}`
    p.drawText(wrap(foot, regular, size, inner - 80)[0], { x: MARGIN, y: MARGIN - 18, size, font: regular, color: colour(COLOURS.soft) })
    p.drawText(right, { x: W - MARGIN - regular.widthOfTextAtSize(right, size), y: MARGIN - 18, size, font: regular, color: colour(COLOURS.soft) })
  })

  return doc.save()
}
