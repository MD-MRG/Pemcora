import { reportImage } from './logo.js'
import { answerTone } from './testTypes.js'
import { buildReportSnapshot } from './reportSnapshot.js'

// Excel report for a visit.
//
// The generated file is never stored — the data that produced it lives in the
// store, so any revision can be regenerated on demand. A "revision" is therefore
// a number recorded against the visit, stamped into the filename and the report
// header, not a saved binary.
//
// What the rooms and the whole site say comes from buildReportSnapshot(), the
// same walk over the visit that a sent report keeps, so the two always agree.

// Characters Windows and iOS refuse in a filename.
const sanitise = s =>
  String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

export function buildFilename(client, visit, revision, reportTitle = 'Preventative Maintenance') {
  const date = (visit?.completedAt ?? visit?.startedAt ?? '').slice(0, 10)
  const parts = [reportTitle, sanitise(client.name), date].filter(Boolean)
  const base = parts.join(' ')
  return revision > 1 ? `${base} Rev ${revision}.xlsx` : `${base}.xlsx`
}

// The merged comment cell spans both columns, so its usable width is roughly
// their two widths added together. Excel row height is in points and a default
// row is 15, so one wrapped line costs about that much.
const COMMENT_WIDTH = 88
const LINE_POINTS = 15
// Somewhere to stop: a 200-line comment must not produce a page-tall row that
// pushes the next room off the screen.
const MAX_COMMENT_LINES = 24

export function commentHeight(text) {
  const s = String(text ?? '')
  if (!s.trim()) return undefined
  // Count the lines the technician typed AND the ones wrapping will add.
  const lines = s
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / COMMENT_WIDTH)), 0)
  return Math.min(lines, MAX_COMMENT_LINES) * LINE_POINTS + 4
}

const GREY = 'FFE5E7EB'
const NAVY = 'FF1B3A5C'
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })

/**
 * Pure — builds and returns the workbook. No DOM, so it can be exercised in
 * Node as well as the browser.
 */
export async function buildWorkbook({ client, location, visit, rooms, revision, reportTitle = 'Preventative Maintenance', settings = null, assets = [] }) {
  const mod = await import('exceljs')
  const ExcelJS = mod.default ?? mod

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Pemcora'
  wb.created = new Date()

  const ws = wb.addWorksheet('PM Report')
  ws.columns = [{ width: 46 }, { width: 42 }]

  const blank = () => ws.addRow([])
  const merge = row => ws.mergeCells(`A${row.number}:B${row.number}`)

  const title = text => {
    const r = ws.addRow([text])
    merge(r)
    r.getCell(1).font = { bold: true, size: 16 }
    return r
  }
  const kv = (k, v) => {
    const r = ws.addRow([k, v])
    r.getCell(1).font = { bold: true }
    return r
  }
  const roomHeader = text => {
    const r = ws.addRow([text])
    merge(r)
    r.getCell(1).font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }
    r.getCell(1).fill = fill(NAVY)
    r.height = 20
    return r
  }
  const sectionHeader = text => {
    const r = ws.addRow([text])
    merge(r)
    r.getCell(1).font = { bold: true }
    r.getCell(1).fill = fill(GREY)
    return r
  }
  const resultRow = test => {
    const r = ws.addRow([test.label, test.answer])
    const c = r.getCell(2)
    const tone = answerTone(test, test.value)
    if (tone === 'pass') c.font = { bold: true, color: { argb: 'FF1E7A45' } }
    else if (tone === 'fail') c.font = { bold: true, color: { argb: 'FFC22E1C' } }
    else if (tone === 'na') c.font = { color: { argb: 'FF7C8894' } }
    return r
  }

  // ── Who produced this ──────────────────────────────────────────────────
  // The report reaches a client, so it has to say who it came from. The logo
  // floats over the top-left; the company lines sit beside and below it.
  const company = settings?.company ?? {}
  const image = reportImage(settings?.logoFull ?? settings?.logoCollapsed)
  if (image) {
    try {
      const imageId = wb.addImage({ base64: image.base64, extension: image.extension })
      ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 190, height: 52 } })
      // Reserve the height the floating image occupies.
      ws.addRow([]).height = 44
    } catch {
      /* an unusable image must not cost the client their report */
    }
  }
  if (company.name) {
    const r = ws.addRow([company.name])
    merge(r)
    r.getCell(1).font = { bold: true, size: 13, color: { argb: NAVY } }
  }
  const contact = [company.abn && `ABN ${company.abn}`, company.phone, company.email]
    .filter(Boolean)
    .join('  ·  ')
  if (contact) {
    const r = ws.addRow([contact])
    merge(r)
    r.getCell(1).font = { size: 10, color: { argb: 'FF6A7683' } }
  }
  if (company.name || contact || image) blank()

  title(reportTitle)
  // A revised report has to announce itself, or the client cannot tell two
  // copies apart.
  if (revision > 1) {
    const r = ws.addRow([`Revision ${revision}`])
    merge(r)
    r.getCell(1).font = { bold: true, size: 12, color: { argb: 'FFC22E1C' } }
  }
  blank()
  kv('Client', client.name ?? '')
  kv('Address', [location.address, location.suburb, location.city, location.state, location.postcode]
    .filter(Boolean).join(', '))
  kv('Technician', visit.technician ?? '')
  kv('Visit started', (visit.startedAt ?? '').slice(0, 10))
  kv('Visit completed', (visit.completedAt ?? '').slice(0, 10))
  blank()

  const snapshot = buildReportSnapshot({ client, visit, rooms, assets, revision, reportTitle })

  // Fails and their notes, then the comments — the close of a room and of the
  // whole site alike.
  const notesAndComments = ({ failed, comments }) => {
    sectionHeader('Troubleshooting')
    if (failed.length === 0) {
      ws.addRow(['No issues identified.'])
    } else {
      failed.forEach(f => {
        const r = ws.addRow([f.item ? `${f.item} — ${f.label}` : f.label, f.note])
        r.getCell(2).alignment = { wrapText: true, vertical: 'top' }
      })
    }
    blank()

    sectionHeader('Comments')
    const cr = ws.addRow([comments || ''])
    merge(cr)
    cr.getCell(1).alignment = { wrapText: true, vertical: 'top' }
    // wrapText alone is not enough here. Excel auto-fits row height for wrapped
    // text only in UNMERGED cells; this one spans A:B, so without an explicit
    // height a long comment is clipped to a single line and the rest is
    // invisible in the file the client receives.
    cr.height = commentHeight(comments)
    blank()
    blank()
  }

  // Sections that happen once per visit come before the rooms. A visit with
  // none — every AV visit — has no such block.
  if (snapshot.site) {
    roomHeader('Whole site')
    blank()
    for (const section of snapshot.site.sections) {
      sectionHeader(section.label)
      if (section.scope !== 'item') {
        section.tests.forEach(resultRow)
      } else if (section.items.length === 0) {
        ws.addRow(['No items recorded'])
      } else {
        for (const item of section.items) {
          const r = ws.addRow([item.room ? `${item.label} (${item.room})` : item.label])
          merge(r)
          r.getCell(1).font = { bold: true }
          item.tests.forEach(resultRow)
        }
      }
      blank()
    }
    notesAndComments(snapshot.site)
  }

  snapshot.rooms.forEach((room, idx) => {
    roomHeader(`Room ${idx + 1}: ${room.name || '(unnamed)'}`)
    kv('Floor', room.floor || '')
    if (room.planNumber) kv('Floor plan no.', room.planNumber)
    blank()

    if (!room.tested) {
      ws.addRow(['Not tested during this visit'])
      blank()
      blank()
      return
    }

    for (const section of room.sections) {
      sectionHeader(section.label)
      section.tests.forEach(resultRow)
      blank()
    }
    notesAndComments(room)
  })

  return wb
}

export function triggerDownload(buffer, filename) {
  const blob =
    buffer instanceof Blob
      ? buffer
      : new Blob([buffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function downloadReport({ client, location, visit, rooms, revision, reportTitle, settings, assets }) {
  const wb = await buildWorkbook({ client, location, visit, rooms, revision, reportTitle, settings, assets })
  const buffer = await wb.xlsx.writeBuffer()
  const filename = buildFilename(client, visit, revision, reportTitle)
  triggerDownload(buffer, filename)
  return filename
}
