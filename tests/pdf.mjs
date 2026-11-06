/**
 * Step D1: the PDF report.
 *
 * In Node first: PDFs built from an AV visit and a Victorian electrical check,
 * read back with pdf.js (Mozilla's PDF reader, the one browsers use), for what
 * they print and where. Then in a browser in test mode: "Export PDF".
 *
 *   node tests/pdf.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - the PDF says what the Excel report says: the same snapshot, laid out
 *   - who it's from, with licence and REC numbers, and the logo unless the plan
 *     says no
 *   - a corrected report says it's a revision, on every page
 *   - fails stand out with their notes, and "Ω", "—" and "·" print
 *   - nothing runs off the page, and a long report goes onto more pages
 *   - a check that is signed off shows who signed it, and the signature
 *   - "Export PDF" goes the way "Export report" does: signed off first where
 *     that's how the check ends, and counted as a revision
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// templateStore.js keeps edits in localStorage: give it one before it loads.
const store = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
})
const { getTemplate } = await import('../src/lib/templateStore.js')
const { buildPdf, wrap } = await import('../src/lib/pdfReport.js')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const FONTS = {
  regular: readFileSync(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url)),
  bold: readFileSync(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf', import.meta.url)),
}
// A 1×1 PNG, for a logo.
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// What a PDF holds: each page's text, where each piece sits, and what it draws.
async function read(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const { width } = page.getViewport({ scale: 1 })
    // pdf.js hands back the gap between two columns as a blank piece, and folds
    // runs of spaces: read the words.
    const items = (await page.getTextContent()).items.filter(it => it.str.trim())
    const ops = await page.getOperatorList()
    pages.push({
      width,
      items,
      text: items.map(it => it.str.replace(/\s+/g, ' ').trim()).join('\n'),
      images: ops.fnArray.filter(f => f === pdfjs.OPS.paintImageXObject).length,
      paths: ops.fnArray.filter(f => f === pdfjs.OPS.constructPath).length,
    })
  }
  return { pages, text: pages.map(p => p.text).join('\n') }
}

// ── An AV visit ─────────────────────────────────────────────────────────────
const pm = getTemplate('maintenance')
const avVisit = {
  technician: 'Pat',
  startedAt: '2026-10-01T00:00:00Z',
  completedAt: '2026-10-01T02:00:00Z',
  rooms: {
    r1: {
      template: pm,
      sections: {},
      results: { main: { [pm.tests[0].id]: 'PASS', [pm.tests[1].id]: 'FAIL' } },
      troubleshooting: { [pm.tests[1].id]: 'Panel rebooted' },
      comments: 'Rack tidy required',
    },
  },
}
const avRooms = [
  { id: 'r1', name: 'Reception', floorLabel: 'Ground' },
  { id: 'r2', name: 'Boardroom', floorLabel: 'Ground' },
]
const av = await read(await buildPdf({
  client: { name: 'Equinix' }, location: { address: '8 Grand Avenue', suburb: 'Rosehill' }, visit: avVisit, rooms: avRooms,
  revision: 1, reportTitle: 'Preventative Maintenance', settings: { company: { name: 'Northpoint AV', phone: '02 9000 0000' } }, fonts: FONTS,
}))
log('an AV report says what it is, for whom and where',
  /Preventative Maintenance/.test(av.text) && /Equinix/.test(av.text) && /8 Grand Avenue, Rosehill/.test(av.text) && /Northpoint AV/.test(av.text))
log('each room\'s results, as answered',
  /Room 1: Reception/.test(av.text) && av.text.includes(`${pm.tests[0].label}\nPASS`) && av.text.includes(`${pm.tests[1].label}\nFAIL`))
log('its fail with the note on it, and the comments',
  /Troubleshooting\n[^]*Panel rebooted/.test(av.text) && /Rack tidy required/.test(av.text))
log('a room not opened says so', /Room 2: Boardroom[^]*Not tested during this visit/.test(av.text))
log('and nothing an AV visit doesn\'t have: no sign-off, no equipment, no revision',
  !/Signed off|Equipment|Revision/.test(av.text))
log('every page says what it belongs to', av.pages.every((p, i) => p.text.includes(`Page ${i + 1} of ${av.pages.length}`) && /Preventative Maintenance · Equinix/.test(p.text)))

// ── A Victorian electrical check, signed off and corrected ─────────────────
const vic = getTemplate('vic_electrical_safety')
const sec = label => vic.sections.find(s => s.label.startsWith(label))
const test = (label, name) => sec(label).tests.find(t => t.label === name)
const visual = sec('C.'), earth = sec('D2.'), rcd = sec('D3.')
const SIGNATURE = 'M30 120 L60 80 L90 130 L120 70 L150 140 L200 90 L260 120 L320 60 L400 130 L480 90'
const longComment = Array.from({ length: 60 }, (_, i) => `Note ${i + 1}: switchboard labels faded and need replacing before the next check.`).join(' ')
const elecVisit = {
  kind: 'vic_electrical_safety',
  technician: 'Sam',
  startedAt: '2026-11-06T00:00:00Z',
  completedAt: '2026-11-06T03:00:00Z',
  outcome: 'non_compliant',
  signoff: { technician: 'Sam Sparks', licence_number: 'A12345', signed_at: '2026-11-06T03:00:00Z', signature: SIGNATURE },
  rooms: {},
  siteResults: {
    template: vic,
    results: {
      [visual.id]: { [test('C.', 'Switchboards').id]: 'Defect found', [test('C.', 'Consumers mains').id]: 'Checked' },
      [earth.id]: { [test('D2.', 'Mains earth conductor').id]: 'PASS' },
      [rcd.id]: { rcd1: { [rcd.tests[1].id]: 'FAIL', [rcd.tests[2].id]: 'PASS' } },
    },
    readings: { [earth.id]: { [test('D2.', 'Mains earth conductor').id]: { value: '0.12', unit: 'Ω' } } },
    troubleshooting: {
      [test('C.', 'Switchboards').id]: 'Cover missing — replaced on site',
      [`rcd1:${rcd.tests[1].id}`]: 'Did not trip; RCD replaced',
    },
    comments: longComment,
  },
}
const elecArgs = {
  client: { name: 'Rental Co' }, location: { address: '10 Smith St', suburb: 'Richmond', state: 'VIC' }, visit: elecVisit,
  rooms: [{ id: 'garage', name: 'Garage', floorLabel: 'Ground' }], revision: 2, reportTitle: 'Electrical Safety Check',
  settings: { company: { name: 'Sparks Electrical', abn: '12 345', licence_number: 'L-9', rec_number: 'REC-77', email: 'office@sparks.test' }, logoFull: { reportSrc: LOGO } },
  assets: [{ id: 'rcd1', assetType: 'rcd', label: 'RCD 1 — lights', roomId: 'garage', attributes: { rating: '30' }, createdAt: '2025-01-01T00:00:00Z' }],
  fonts: FONTS,
}
const elec = await read(await buildPdf(elecArgs))
log('who it\'s from, with the business\'s licence and REC numbers',
  /Sparks Electrical/.test(elec.text) && /ABN 12 345 · Licence L-9 · REC REC-77 · office@sparks\.test/.test(elec.text), elec.pages[0].text.slice(0, 200))
log('a corrected report says it\'s a revision, at the top and on every page',
  /Electrical Safety Check\nRevision 2/.test(elec.text) && elec.pages.every(p => /Electrical Safety Check · Rental Co · Revision 2/.test(p.text)))
log('the declared outcome', /Outcome\nNon-compliant/.test(elec.text))
log('a defect found and a reading with its unit print as answered',
  elec.text.includes('Switchboards\nDefect found') && elec.text.includes('Mains earth conductor\n0.12 Ω — PASS'))
log('each RCD under its name and room', /RCD 1 — lights \(Garage\)\nCircuit protected[^]*Push-button test\nFAIL/.test(elec.text))
log('the issues, each with its note, and "—" printed',
  elec.text.includes('Switchboards\nCover missing — replaced on site') && elec.text.includes('RCD 1 — lights — Push-button test\nDid not trip; RCD replaced'))
log('the equipment', /Equipment\nRCDs\nRCD 1 — lights \(Garage\)\nRated trip current\n30 mA/.test(elec.text))
log('who signed it off, with their licence number',
  /Signed off\nName\nSam Sparks\nLicence or registration number\nA12345\nSigned\n2026-11-06/.test(elec.text))

const unsigned = await read(await buildPdf({ ...elecArgs, visit: { ...elecVisit, signoff: { ...elecVisit.signoff, signature: '' } } }))
log('and the signature is drawn from its path',
  elec.pages.at(-1).paths > unsigned.pages.at(-1).paths && /Signature/.test(elec.pages.at(-1).text) && !/Signature/.test(unsigned.text))
log('the logo is on it', elec.pages[0].images === 1)
const noLogo = await read(await buildPdf({ ...elecArgs, showLogo: false }))
log('unless the plan says no', noLogo.pages[0].images === 0 && /Sparks Electrical/.test(noLogo.text))

log('a long report goes onto more pages, numbered', elec.pages.length > 1 && elec.pages.every((p, i) => p.text.includes(`Page ${i + 1} of ${elec.pages.length}`)), `${elec.pages.length} pages`)
const overflow = elec.pages.flatMap(p => p.items.filter(it => it.transform[4] < 41 || it.transform[4] + it.width > p.width - 41).map(it => it.str))
log('and nothing runs off the page', overflow.length === 0, overflow.slice(0, 3).join(' | '))
// The footer sits 24 points up; nothing else goes that low.
const sunk = elec.pages.flatMap(p => p.items.filter(it => it.transform[5] < 40 && !/^Page \d|^Electrical Safety Check ·/.test(it.str)).map(it => it.str))
log('or over the footer', sunk.length === 0, sunk.slice(0, 3).join(' | '))

// ── The Victorian check, laid out as ESV's form (D1b) ───────────────────────
const siteVisits = [
  { id: 'old', kind: 'vic_electrical_safety', completedAt: '2024-10-01T01:00:00Z' },
  { id: 'smoke', kind: 'vic_smoke_alarm', completedAt: '2026-03-01T01:00:00Z' },
  { id: 'later', kind: 'vic_electrical_safety', completedAt: '2027-01-01T01:00:00Z' }, // after this one: not "previous"
]
const esvArgs = { ...elecArgs, layout: 'esv', location: { ...elecArgs.location, visits: siteVisits }, settings: { ...elecArgs.settings, logoFull: null } }
const esv = await read(await buildPdf(esvArgs))
const order = ['A. Installation', 'B. Extent', 'C. Visual inspection', 'D1. Polarity', 'D2. Earth', 'D3. RCD', 'E. Smoke alarms', 'F. Observations', 'Certification']
const at = order.map(h => esv.text.indexOf(h))
log('the Victorian PDF follows the form: sections A to F, then certification',
  at.every((p, i) => p >= 0 && (i === 0 || p > at[i - 1])), order.map((h, i) => `${h}@${at[i]}`).join(', '))
log('with no "Whole site" or separate Troubleshooting part', !/Whole site|Troubleshooting/.test(esv.text))
log('section A gives the address and the dates of this check and the one before',
  /A\. Installation\nAddress\n10 Smith St, Richmond, VIC\nClient\nRental Co\nDate of this check\n2026-11-06\nDate of the previous check\n2024-10-01/.test(esv.text), esv.text.slice(esv.text.indexOf('A. Installation'), esv.text.indexOf('A. Installation') + 200))
log('section E says when the smoke alarms are next due, from the site\'s smoke alarm check',
  /Next smoke alarm check due\n2027-03-01/.test(esv.text))
const fPart = esv.text.slice(at[7], at[8])
log('section F lists each defect with what was done, and the comments',
  fPart.includes('Switchboards\nCover missing — replaced on site') && fPart.includes('RCD 1 — lights — Push-button test\nDid not trip; RCD replaced') && /Note 1:/.test(fPart))
const cert = esv.text.slice(at[8])
log('the certification names the electrician, business, REC and licence numbers, and the dates',
  /Electrician\nSam Sparks\nBusiness name\nSparks Electrical\nREC number\nREC-77\nLicence or registration number\nA12345\nInspection date\n2026-11-06\nNext check due\n2028-11-06\nOutcome declared\nNon-compliant/.test(cert), cert.slice(0, 300))
log('with the declaration and the signature',
  cert.replace(/\n/g, ' ').includes('I certify that this electrical safety check was carried out in accordance with section 4 of AS/NZS 3019') && /Signature/.test(cert))
const esvBare = await read(await buildPdf({ ...esvArgs, location: { ...elecArgs.location, visits: [] } }))
log('with nothing on record, it says so', /Date of the previous check\nNone on record/.test(esvBare.text) && /Next smoke alarm check due\nNo smoke alarm check on record/.test(esvBare.text))
const esvOverflow = esv.pages.flatMap(p => p.items.filter(it => it.transform[4] + it.width > p.width - 41 || (it.transform[5] < 40 && !/^Page \d|^Electrical Safety Check ·/.test(it.str))).map(it => it.str))
log('and nothing runs off its pages either', esvOverflow.length === 0, esvOverflow.slice(0, 3).join(' | '))
log('every other workflow keeps the standard layout', /Whole site/.test(elec.text) && !/A\. Installation|Certification/.test(elec.text))

// Wrapping, on its own.
const { PDFDocument } = await import('pdf-lib')
const fontkit = (await import('@pdf-lib/fontkit')).default
const scratch = await PDFDocument.create()
scratch.registerFontkit(fontkit)
const font = await scratch.embedFont(FONTS.regular)
const lines = wrap('one two three four five six seven eight nine ten', font, 10, 60)
log('text wraps at word breaks, inside the width', lines.length > 1 && lines.every(l => font.widthOfTextAtSize(l, 10) <= 60) && lines.join(' ') === 'one two three four five six seven eight nine ten', lines.join(' / '))
const long = wrap('Supercalifragilisticexpialidocious', font, 10, 50)
log('and a word too long for the line goes in pieces', long.length > 1 && long.join('') === 'Supercalifragilisticexpialidocious' && long.every(l => font.widthOfTextAtSize(l, 10) <= 50))
log('a line break typed in a note is kept', wrap('first\nsecond', font, 10, 400).join('|') === 'first|second')
delete globalThis.localStorage

// ── "Export PDF" in the app ─────────────────────────────────────────────────
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}
const SEED = [
  {
    id: 'c1', name: 'Rental Co',
    locations: [{
      id: 'l1', address: '10 Smith St', suburb: 'Toowong', city: 'Brisbane', state: 'QLD', postcode: '4066',
      floors: [{ id: 'f1', label: 'Upstairs', rooms: [{ id: 'b1', name: 'Bedroom 1', planNumber: '', roomType: 'bedroom' }] }],
      visits: [],
    }],
  },
]
const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients'))[0].locations[0])
  const openSite = async path => {
    await page.goto(BASE + path, { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
    await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
  }
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(seed => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
    localStorage.removeItem('fc.templates')
    localStorage.setItem('fc.settings', JSON.stringify({ technician: 'Sam Sparks', company: { name: 'Sparks Electrical' } }))
  }, SEED)

  // An AV visit.
  await openSite('#/maintenance')
  await page.getByRole('button', { name: 'Start PM' }).click()
  let download = page.waitForEvent('download', { timeout: 20000 })
  await page.getByRole('button', { name: 'Export PDF' }).click()
  let file = await download
  let bytes = readFileSync(await file.path())
  log('"Export PDF" downloads a PDF, named as the Excel report is',
    bytes.subarray(0, 5).toString() === '%PDF-' && /^Preventative Maintenance Rental Co \d{4}-\d{2}-\d{2}\.pdf$/.test(file.suggestedFilename()), file.suggestedFilename())
  const pmVisit = (await stored()).visits.find(v => v.kind === 'maintenance')
  log('and counts as the report\'s first revision, finishing the visit as exporting does',
    pmVisit.exports?.length === 1 && pmVisit.exports[0].filename.endsWith('.pdf') && !!pmVisit.completedAt)
  const read1 = await read(bytes)
  log('built from the visit, by the app\'s own fonts', /Preventative Maintenance/.test(read1.text) && /Room 1: Bedroom 1/.test(read1.text))

  // A smoke alarm inspection ends in a sign-off, PDF or not.
  await openSite('#/qld-smoke-alarm')
  await page.getByRole('button', { name: 'Start smoke alarm inspection' }).click()
  await page.getByRole('button', { name: 'Export PDF' }).click()
  log('exporting a check that ends in a sign-off asks for it first', (await page.getByRole('dialog').getAttribute('aria-label')) === 'Sign off this smoke alarm inspection')
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Compliant', { exact: true }).check()
  await dialog.getByLabel('Licence or registration number').fill('QLD-77')
  const pad = dialog.getByRole('img', { name: /Signature/ })
  const box = await pad.boundingBox()
  await page.mouse.move(box.x + 30, box.y + 60)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 20, box.y + 60 + (i % 3) * 12)
  await page.mouse.up()
  download = page.waitForEvent('download', { timeout: 20000 })
  await dialog.getByRole('button', { name: 'Sign and finish' }).click()
  file = await download
  const signed = await read(readFileSync(await file.path()))
  log('then the PDF goes, signed', file.suggestedFilename().endsWith('.pdf') && /Outcome\nCompliant/.test(signed.text) && /Signed off\nName\nSam Sparks/.test(signed.text) && /Signature/.test(signed.text))

  // A second export asks revision or replace, as Excel's does.
  await page.getByRole('button', { name: 'Export PDF' }).click()
  log('a second export asks whether it\'s a revision', (await page.getByRole('dialog').count()) === 1 && /revision/i.test(await page.getByRole('dialog').textContent()))
  await page.screenshot({ path: `${DIR}/pdf-export.png` })

  // The Victorian check's PDF follows the form.
  await openSite('#/vic-electrical-safety')
  await page.getByRole('button', { name: 'Start electrical safety check' }).click()
  await page.getByRole('button', { name: 'Export PDF' }).click()
  const vicDialog = page.getByRole('dialog')
  await vicDialog.getByLabel('Compliant', { exact: true }).check()
  await vicDialog.getByLabel('Licence or registration number').fill('VIC-5')
  const vicPad = await vicDialog.getByRole('img', { name: /Signature/ }).boundingBox()
  await page.mouse.move(vicPad.x + 30, vicPad.y + 60)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(vicPad.x + 30 + i * 20, vicPad.y + 60 + (i % 3) * 12)
  await page.mouse.up()
  download = page.waitForEvent('download', { timeout: 20000 })
  await vicDialog.getByRole('button', { name: 'Sign and finish' }).click()
  const vicPdf = await read(readFileSync(await (await download).path()))
  log('the Victorian page\'s PDF is laid out as ESV\'s form', /A\. Installation/.test(vicPdf.text) && /Certification\nElectrician\nSam Sparks/.test(vicPdf.text) && !/Whole site/.test(vicPdf.text))
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
