import { reportImage } from './logo.js'

// Excel report for a visit.
//
// The generated file is never stored — the data that produced it lives in the
// store, so any revision can be regenerated on demand. A "revision" is therefore
// a number recorded against the visit, stamped into the filename and the report
// header, not a saved binary.

const RESULT_TEXT = { PASS: 'PASS', FAIL: 'FAIL', NA: 'N/A' }
// Blank stays blank — a test left unanswered is not "not applicable".
const resultText = v => (v ? (RESULT_TEXT[v] ?? v) : '')

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
export async function buildWorkbook({ client, location, visit, rooms, revision, reportTitle = 'Preventative Maintenance', settings = null }) {
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
  const resultRow = (label, value) => {
    const r = ws.addRow([label, resultText(value)])
    const c = r.getCell(2)
    if (value === 'PASS') c.font = { bold: true, color: { argb: 'FF1E7A45' } }
    else if (value === 'FAIL') c.font = { bold: true, color: { argb: 'FFC22E1C' } }
    else if (value === 'NA') c.font = { color: { argb: 'FF7C8894' } }
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

  rooms.forEach((room, idx) => {
    const entry = visit.rooms?.[room.id] ?? {}
    const template = entry.template
    // A room never opened has no snapshot; report it as untested rather than
    // inventing a test list for it.
    roomHeader(`Room ${idx + 1}: ${room.name || '(unnamed)'}`)
    kv('Floor', room.floorLabel || '')
    if (room.planNumber) kv('Floor plan no.', room.planNumber)
    blank()

    if (!template) {
      ws.addRow(['Not tested during this visit'])
      blank()
      blank()
      return
    }

    sectionHeader(template.mainLabel || 'Main test list')
    template.tests.forEach(t => resultRow(t.label, entry.results?.main?.[t.id]))
    blank()

    // Only sections switched on for this room reach the report.
    const visible = template.sections.filter(s => entry.sections?.[s.id])
    for (const section of visible) {
      sectionHeader(section.label)
      section.tests.forEach(t => resultRow(t.label, entry.results?.[section.id]?.[t.id]))
      blank()
    }

    const failed = [
      ...template.tests.filter(t => entry.results?.main?.[t.id] === 'FAIL'),
      ...visible.flatMap(s => s.tests.filter(t => entry.results?.[s.id]?.[t.id] === 'FAIL')),
    ]
    sectionHeader('Troubleshooting')
    if (failed.length === 0) {
      ws.addRow(['No issues identified.'])
    } else {
      failed.forEach(t => {
        const r = ws.addRow([t.label, entry.troubleshooting?.[t.id] || ''])
        r.getCell(2).alignment = { wrapText: true, vertical: 'top' }
      })
    }
    blank()

    sectionHeader('Comments')
    const cr = ws.addRow([entry.comments || ''])
    merge(cr)
    cr.getCell(1).alignment = { wrapText: true, vertical: 'top' }
    // wrapText alone is not enough here. Excel auto-fits row height for wrapped
    // text only in UNMERGED cells; this one spans A:B, so without an explicit
    // height a long comment is clipped to a single line and the rest is
    // invisible in the file the client receives.
    cr.height = commentHeight(entry.comments)
    blank()
    blank()
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

export async function downloadReport({ client, location, visit, rooms, revision, reportTitle, settings }) {
  const wb = await buildWorkbook({ client, location, visit, rooms, revision, reportTitle, settings })
  const buffer = await wb.xlsx.writeBuffer()
  const filename = buildFilename(client, visit, revision, reportTitle)
  triggerDownload(buffer, filename)
  return filename
}
