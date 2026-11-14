/**
 * Room photos (0022): photos kept with a site's room, in two groups (General
 * and Issues), each with a description and the date it was added, and a
 * full-quality copy to download.
 *
 * In a browser in test mode. Every request off this machine is answered here,
 * as the database and the photo bucket would answer it, or refused: nothing can
 * reach the live project.
 *
 *   node tests/room-photos.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - the API: a photo's record goes first, with its group, in the team's own
 *     folder under rooms/<room>/, then its two files (display copy, then the
 *     full-quality one); a file that fails to upload takes the other file and
 *     the record with it; a photo moves between groups; a download link points
 *     at the full-quality file, named for the client, room, group and date; a
 *     deleted photo loses both files, then its record; a deleted room, floor,
 *     site or client loses its photos' files before it goes
 *   - who has room photos comes from room_photos_allowed(), beside the
 *     entitlements; before 0022, nobody, and deleting a room works as it did
 *   - full quality: a JPEG under the bucket's 10 MB is kept as it was taken;
 *     anything else becomes the best JPEG that fits, saying when it was reduced
 *   - the Photos section, on the room during a visit and in the site's room
 *     editor: General and Issues, photos added to the one chosen, several at
 *     once, up to 20 a group; descriptions saved when the box is left (300
 *     characters); "Added <date> by <who>"; full size; move; download; delete
 *     after asking; a refusal gets the upgrade sheet; no signal says so; an
 *     observer can look but not change; a team without room photos, no team,
 *     or no 0022: no section at all
 *   - reports: only photos added by the day the visit was completed; the PDF
 *     asks which to carry (all, General, Issues or none) when it's downloaded
 *     or sent, and carries those at about 1000 px, under General and Issues;
 *     one that can't be fetched leaves the report building, saying so; the
 *     Excel report is unchanged
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

// The report builders are pure: they run here, in Node. templateStore.js (under
// them) keeps edits in localStorage, so give it one before it loads.
const store = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
})
const { buildReportSnapshot, photosAtVisit, photosForChoice } = await import('../src/lib/reportSnapshot.js')
const { buildPdf } = await import('../src/lib/pdfReport.js')
const { buildWorkbook } = await import('../src/lib/report.js')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

// What a PDF holds: each page's text and how many images it draws.
async function read(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, verbosity: 0 }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const items = (await page.getTextContent()).items.filter(it => it.str.trim())
    const ops = await page.getOperatorList()
    pages.push({
      text: items.map(it => it.str.replace(/\s+/g, ' ').trim()).join('\n'),
      images: ops.fnArray.filter(f => f === pdfjs.OPS.paintImageXObject).length,
    })
  }
  return { pages, text: pages.map(p => p.text).join('\n'), images: pages.reduce((n, p) => n + p.images, 0) }
}

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'
const localhost = new URL(BASE).hostname

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(check, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

// A JPEG's width and height, from its frame header, wherever in the body it sits.
function jpegSize(buf) {
  let i = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
  if (i < 0) return null
  i += 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null
    const marker = buf[i + 1]
    const length = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
    i += 2 + length
  }
  return null
}
// What a form upload carried: the file between the first start-of-file marker
// and the last end-of-file one.
const inner = (buf, start, end) => {
  const a = buf.indexOf(start)
  const b = buf.lastIndexOf(end)
  return a >= 0 && b > a ? buf.subarray(a, b + end.length) : buf
}

const TEAM = '11111111-1111-4111-8111-111111111111'
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MEMBERS = [
  { user_id: ME, email: 'me@sparky.test', role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
  { user_id: PAT, email: 'pat@sparky.test', role: 'member', joined_at: '2026-01-02T00:00:00Z' },
]

// ── The stand-in database and photo bucket ──────────────────────────────────
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
// A 1×1 PNG, for a file the page only shows.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const server = {}
const reset = () => {
  Object.assign(server, {
    rows: [],          // attachments
    files: new Map(),  // evidence bucket: path → bytes
    reports: [],       // PDFs put in the reports bucket
    sent: [],          // what send_report() was asked to keep
    requests: [],
    missing: false,    // 0022 not applied: no room_id, no room_photos_allowed()
    allowed: true,     // room_photos_allowed() for this team
    refuse: false,     // the gate says no
    failUpload: null,  // 'display' or 'original': that upload fails
    failRemove: false,
    as: ME,
    clock: Date.parse('2026-11-10T00:00:00Z'),
  })
  server.rooms = new Map([['r1', 'f1'], ['r2', 'f1'], ['r3', 'f2']])
  server.floors = new Map([['f1', 'l1'], ['f2', 'l2']])
  server.sites = new Map([['l1', 'c1'], ['l2', 'c1']])
}
reset()

// PostgREST's filters, as the app sends them: eq.x and in.(x,y).
const matches = (row, params) =>
  [...params].every(([key, value]) => {
    if (['select', 'order', 'limit', 'offset', 'columns'].includes(key)) return true
    if (value.startsWith('eq.')) return String(row[key]) === value.slice(3)
    if (value.startsWith('in.(')) return value.slice(4, -1).split(',').map(s => s.replace(/"/g, '')).includes(String(row[key]))
    return true
  })
const missingColumn = (route, write) =>
  json(route, 400, write
    ? { code: 'PGRST204', message: "Could not find the 'room_id' column of 'attachments' in the schema cache", details: null, hint: null }
    : { code: '42703', message: 'column attachments.room_id does not exist', details: null, hint: null })
const usesRoomId = (url, body) => url.search.includes('room_id') || (body && 'room_id' in body)

function deleteRooms(ids) {
  for (const id of ids) server.rooms.delete(id)
  server.rows = server.rows.filter(r => !ids.includes(r.room_id))
}

async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const path = decodeURIComponent(url.pathname)
  const method = req.method()
  const raw = req.postData()
  const body = raw && req.headers()['content-type']?.includes('json') ? JSON.parse(raw) : null
  server.requests.push({ method, path, search: decodeURIComponent(url.search), body })
  const single = (req.headers().accept ?? '').includes('vnd.pgrst.object')
  const params = url.searchParams

  // ── attachments ──
  if (path === '/rest/v1/attachments') {
    if (server.missing && usesRoomId(url, body)) return missingColumn(route, method !== 'GET')
    if (method === 'GET') {
      let rows = server.rows.filter(r => matches(r, params))
      const order = params.get('order')
      if (order) {
        const [col, dir] = order.split('.')
        rows = rows.slice().sort((a, b) => (a[col] < b[col] ? -1 : 1) * (dir === 'desc' ? -1 : 1))
      }
      if (params.get('limit')) rows = rows.slice(0, Number(params.get('limit')))
      return json(route, 200, rows)
    }
    if (method === 'POST') {
      if (server.refuse) return json(route, 402, { code: 'PT402', message: 'Room photos are not available to this team', hint: 'upgrade', details: null })
      if (body.room_id && !server.rooms.has(body.room_id)) {
        return json(route, 403, { code: '42501', message: 'new row violates row-level security policy for table "attachments"', details: null, hint: null })
      }
      if (body.room_id && !['general', 'issue'].includes(body.category)) {
        return json(route, 400, { code: '23514', message: 'new row violates check constraint "attachments_room_category"', details: null, hint: null })
      }
      server.clock += 60_000
      // As 0022 does: the server's date and the signed-in person, whatever was sent.
      const row = { id: `p${server.rows.length + 1}-${server.clock}`, caption: '', ...body, taken_at: new Date(server.clock).toISOString(), created_by: server.as }
      server.rows.push(row)
      return json(route, 201, single ? row : [row])
    }
    if (method === 'PATCH') {
      const hit = server.rows.filter(r => matches(r, params))
      for (const r of hit) {
        if ('caption' in body) r.caption = body.caption
        if ('category' in body) r.category = body.category
      }
      return json(route, 200, hit)
    }
    if (method === 'DELETE') {
      server.rows = server.rows.filter(r => !matches(r, params))
      return route.fulfill({ status: 204, headers: cors })
    }
  }
  if (path === '/rest/v1/rpc/team_members_list') return json(route, 200, MEMBERS)
  if (path === '/rest/v1/rpc/room_photos_allowed') {
    if (server.missing) return json(route, 404, { code: 'PGRST202', message: 'Could not find the function', details: null, hint: null })
    return json(route, 200, server.allowed)
  }
  if (path === '/rest/v1/rpc/team_entitlements') {
    return json(route, 200, { enforced: false, plan: 'free', packs: ['core', 'av'], account_type: 'provider' })
  }
  if (path === '/rest/v1/rpc/send_report') {
    server.sent.push(body)
    return json(route, 500, { code: 'XX000', message: 'Not today', details: null, hint: null })
  }
  if (path === '/functions/v1/deliver-report') {
    server.sent.push(body)
    return json(route, 500, { error: 'Not today' })
  }

  // ── the floor plan ──
  if (path === '/rest/v1/rooms' && method === 'GET') {
    const rows = [...server.rooms].map(([id, floor_id]) => ({ id, floor_id })).filter(r => matches(r, params))
    if (single) return rows.length ? json(route, 200, rows[0]) : json(route, 406, { code: 'PGRST116', message: 'no rows' })
    return json(route, 200, rows)
  }
  if (path === '/rest/v1/rooms' && method === 'DELETE') {
    deleteRooms([...server.rooms].map(([id, floor_id]) => ({ id, floor_id })).filter(r => matches(r, params)).map(r => r.id))
    return route.fulfill({ status: 204, headers: cors })
  }
  const roomsOf = floor => [...server.rooms].filter(([, f]) => f === floor).map(([id]) => ({ id }))
  const floorsOf = site => [...server.floors].filter(([, l]) => l === site).map(([id]) => ({ id, rooms: roomsOf(id) }))
  if (path === '/rest/v1/floors' && method === 'GET') {
    return json(route, 200, [...server.floors].map(([id, location_id]) => ({ id, location_id, rooms: roomsOf(id) })).filter(r => matches(r, params)))
  }
  if (path === '/rest/v1/floors' && method === 'DELETE') {
    const id = params.get('id')?.slice(3)
    deleteRooms(roomsOf(id).map(r => r.id))
    server.floors.delete(id)
    return route.fulfill({ status: 204, headers: cors })
  }
  if (path === '/rest/v1/locations' && method === 'GET') {
    return json(route, 200, [...server.sites].map(([id, client_id]) => ({ id, client_id, floors: floorsOf(id) })).filter(r => matches(r, params)))
  }
  if (path === '/rest/v1/locations' && method === 'DELETE') {
    const id = params.get('id')?.slice(3)
    for (const f of floorsOf(id)) deleteRooms(f.rooms.map(r => r.id))
    server.sites.delete(id)
    return route.fulfill({ status: 204, headers: cors })
  }
  if (path === '/rest/v1/clients' && method === 'DELETE') {
    const id = params.get('id')?.slice(3)
    for (const [site, client] of server.sites) {
      if (client !== id) continue
      for (const f of floorsOf(site)) deleteRooms(f.rooms.map(r => r.id))
      server.sites.delete(site)
    }
    return route.fulfill({ status: 204, headers: cors })
  }

  // ── the buckets ──
  const SIGN = '/storage/v1/object/sign/evidence'
  if (path === SIGN && method === 'POST') {
    return json(route, 200, body.paths.map(p => ({ path: p, signedURL: `/object/sign/evidence/${p}?token=t1`, error: null })))
  }
  if (path.startsWith(SIGN + '/') && method === 'POST') {
    return json(route, 200, { signedURL: `/object/sign/evidence/${path.slice(SIGN.length + 1)}?token=t1` })
  }
  if (path.startsWith(SIGN + '/') && params.get('token') === 't1') {
    const bytes = server.files.get(path.slice(SIGN.length + 1))
    if (!bytes) return json(route, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' })
    // As storage does: ?download= makes it a download, by that name.
    const named = params.get('download')
    const headers = named ? { ...cors, 'Content-Disposition': `attachment; filename="${named}"` } : cors
    return route.fulfill({ status: 200, contentType: 'image/jpeg', headers, body: bytes })
  }
  if (path === '/storage/v1/object/evidence' && method === 'DELETE') {
    if (server.failRemove) return json(route, 500, { statusCode: '500', error: 'Internal', message: 'Storage is having a bad day' })
    for (const p of body.prefixes) server.files.delete(p)
    return json(route, 200, body.prefixes.map(name => ({ name })))
  }
  if (path.startsWith('/storage/v1/object/evidence/') && method === 'POST') {
    const where = path.slice('/storage/v1/object/evidence/'.length)
    const which = where.endsWith('-original.jpg') ? 'original' : 'display'
    if (server.failUpload === which) return json(route, 500, { statusCode: '500', error: 'Internal', message: 'Storage is having a bad day' })
    // A Blob goes up as a form; keep the JPEG inside it, as the bucket does.
    server.files.set(where, inner(req.postDataBuffer() ?? PIXEL, Buffer.from([0xff, 0xd8, 0xff]), Buffer.from([0xff, 0xd9])))
    return json(route, 200, { Key: path.slice('/storage/v1/object/'.length) })
  }
  if (path.startsWith('/storage/v1/object/reports/') && method === 'POST') {
    server.reports.push(inner(req.postDataBuffer(), Buffer.from('%PDF-'), Buffer.from('%%EOF')))
    return json(route, 200, { Key: path.slice('/storage/v1/object/'.length) })
  }
  return route.abort()
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  await ctx.route('**/*', backend)
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))

  await page.goto(BASE, { waitUntil: 'networkidle' })

  // A picture of w × h, made by the browser, as bytes: a JPEG unless asked.
  const picture = (w, h, type = 'image/jpeg', quality = 0.9) =>
    page
      .evaluate(
        async ({ w, h, type, quality }) => {
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          const g = c.getContext('2d')
          for (let i = 0; i < 300; i++) {
            g.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`
            g.fillRect((i * 97) % w, (i * 53) % h, w / 20, h / 20)
          }
          const blob = await new Promise(r => c.toBlob(r, type, quality))
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let s = ''
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          return btoa(s)
        },
        { w, h, type, quality },
      )
      .then(b64 => Buffer.from(b64, 'base64'))

  // ═══════════════════════════════════════════════════════════════════════════
  // Reports, in Node: the export filter, the snapshot, the PDF and the workbook
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n— In the report (built in Node)')
  const photoJpeg = await picture(1000, 750)
  const ROOMS = [
    { id: 'r1', name: 'Kitchen', floorLabel: 'Ground', planNumber: '' },
    { id: 'r2', name: 'Lounge', floorLabel: 'Ground', planNumber: '' },
    { id: 'r3', name: 'Laundry', floorLabel: 'Ground', planNumber: '' },
  ]
  const TEMPLATE = { mainLabel: 'Main test list', tests: [{ id: 't1', label: 'Power on' }], sections: [] }
  const VISIT = {
    id: 'v1', technician: 'Sam', startedAt: '2026-11-12T01:00:00.000Z', completedAt: '2026-11-12T05:00:00.000Z',
    rooms: { r1: { template: TEMPLATE, sections: {}, results: { main: { t1: 'PASS' } }, troubleshooting: {}, comments: '' } },
  }
  const PHOTOS = {
    r1: [
      { id: 'k2', category: 'general', caption: 'Switchboard behind the pantry door', takenAt: '2026-11-12T03:00:00+00:00' },
      { id: 'k1', category: 'general', caption: '', takenAt: '2026-11-01T22:00:00+00:00' },
      { id: 'k3', category: 'issue', caption: 'Scorched power point', takenAt: '2026-11-12T23:30:00+00:00' },
      { id: 'k4', category: 'issue', caption: 'Added the next week', takenAt: '2026-11-19T01:00:00+00:00' },
    ],
    r2: [{ id: 'l1', category: 'issue', caption: 'Water stain on the ceiling', takenAt: '2026-11-10T00:00:00+00:00' }],
  }
  const byVisit = photosAtVisit(PHOTOS.r1, VISIT)
  log('a report shows the photos added by the day the visit was completed, oldest first',
    byVisit.map(p => p.id).join() === 'k1,k2,k3', byVisit.map(p => p.id).join())
  log('…and a visit still open shows them all', photosAtVisit(PHOTOS.r1, { ...VISIT, completedAt: null }).length === 4)

  // The export filter (M.D.'s photo choice).
  const ids = include => photosForChoice(byVisit, include).map(p => p.id).join()
  log('the photo choice: All keeps every one', ids('all') === 'k1,k2,k3')
  log('…General only keeps the General ones', ids('general') === 'k1,k2')
  log('…Issues only keeps the Issues ones', ids('issue') === 'k3')
  log('…No photos keeps none', ids('none') === '')
  log('…and anything it doesn\'t know is taken as All', ids(undefined) === 'k1,k2,k3' && ids('bogus') === 'k1,k2,k3')
  log('…a photo with no group on record counts as General', photosForChoice([{ id: 'x' }], 'general').length === 1)

  const snap = buildReportSnapshot({ client: { name: 'Acme Corp' }, visit: VISIT, rooms: ROOMS, roomPhotos: PHOTOS })
  log('the snapshot gives each room its photos, in their group, described and dated',
    JSON.stringify(snap.rooms[0].photos) === JSON.stringify([
      { id: 'k1', category: 'general', caption: '', addedOn: '2026-11-01' },
      { id: 'k2', category: 'general', caption: 'Switchboard behind the pantry door', addedOn: '2026-11-12' },
      { id: 'k3', category: 'issue', caption: 'Scorched power point', addedOn: '2026-11-12' },
    ]) && snap.rooms[1].photos?.[0]?.caption === 'Water stain on the ceiling', JSON.stringify(snap.rooms.map(r => r.photos)))
  const issuesSnap = buildReportSnapshot({ visit: VISIT, rooms: ROOMS, roomPhotos: PHOTOS, include: 'issue' })
  log('…and only the chosen ones, when a choice is made',
    issuesSnap.rooms[0].photos?.map(p => p.id).join() === 'k3' && issuesSnap.rooms[1].photos?.length === 1)
  log('…and a room without photos reads as it always did (no photos key)',
    !('photos' in snap.rooms[2]) && !('photos' in buildReportSnapshot({ visit: VISIT, rooms: ROOMS }).rooms[0]) &&
      !('photos' in buildReportSnapshot({ visit: VISIT, rooms: ROOMS, roomPhotos: PHOTOS, include: 'none' }).rooms[0]))

  const FONTS = {
    regular: readFileSync(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url)),
    bold: readFileSync(new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf', import.meta.url)),
  }
  const pdfArgs = { client: { name: 'Acme Corp' }, location: { address: '1 George St' }, visit: VISIT, rooms: ROOMS, reportTitle: 'Preventative Maintenance', fonts: FONTS }
  const plainPdf = await read(await buildPdf(pdfArgs))
  const pdf = await read(await buildPdf({ ...pdfArgs, roomPhotos: PHOTOS, roomPhotoBytes: { k1: photoJpeg, k2: photoJpeg, l1: photoJpeg } }))
  log('the PDF shows each room\'s photos, with their descriptions and the day added',
    /Switchboard behind the pantry door\nAdded 2026-11-12/.test(pdf.text) && /No description\nAdded 2026-11-01/.test(pdf.text) &&
      /Water stain on the ceiling\nAdded 2026-11-10/.test(pdf.text), pdf.text.split('\n').slice(-30).join(' | '))
  log('…under General, then Issues, in the room they belong to',
    /Room 1: Kitchen[^]*Photos — General[^]*Switchboard[^]*Photos — Issues[^]*Scorched power point[^]*Room 2: Lounge[^]*Not tested during this visit[^]*Photos — Issues[^]*Water stain/.test(pdf.text) &&
      !/Room 2: Lounge[^]*Photos — General/.test(pdf.text))
  log('…the photos themselves', pdf.images === 3 && plainPdf.images === 0)
  log('…a photo that couldn\'t be fetched says so in its place', /Photo not included in this copy\nScorched power point/.test(pdf.text))
  log('…and nothing added after the visit was completed', !/Added the next week/.test(pdf.text))
  log('a room with no photos has no Photos heading, as before', !/Room 3: Laundry[^]*Photos/.test(pdf.text) && !/Photos/.test(plainPdf.text))

  const sheetOf = async args => {
    const rows = []
    ;(await buildWorkbook(args)).worksheets[0].eachRow(r => rows.push(`${r.getCell(1).text} | ${r.getCell(2).text}`))
    return rows.join('\n')
  }
  log('the Excel report is unchanged: no photos and no photo list',
    (await sheetOf({ ...pdfArgs, roomPhotos: PHOTOS })) === (await sheetOf(pdfArgs)) && !/Switchboard|Photos/.test(await sheetOf({ ...pdfArgs, roomPhotos: PHOTOS })))

  const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
  if (!configured) {
    console.log('(the room photo checks need VITE_SUPABASE_URL in .env, and were skipped)')
  } else {
    // Runs an api.js function in the page; a thrown error comes back as { error }.
    // '$files' stands for a photo's two files: a small display copy and a
    // bigger full-quality one.
    const api = (name, ...args) =>
      page.evaluate(
        async ({ name, args }) => {
          const mod = await import('/src/lib/api.js')
          const jpeg = n => new Blob([new Uint8Array([0xff, 0xd8, 0xff, ...Array(n).fill(7), 0xff, 0xd9])], { type: 'image/jpeg' })
          try {
            const given = args.map(a => (a === '$files' ? { display: jpeg(4), original: jpeg(40) } : a))
            return { value: (await mod[name](...given)) ?? null }
          } catch (e) {
            return { error: { code: e?.code ?? '', hint: e?.hint ?? '', message: e?.message ?? String(e) } }
          }
        },
        { name, args },
      )
    const posts = () => server.requests.filter(r => r.method !== 'GET')
    const at = pred => server.requests.findIndex(pred)

    // ── Adding ──────────────────────────────────────────────────────────────
    console.log('\n— The API')
    const added = await api('addRoomPhoto', TEAM, 'r1', '$files', 'general', 'Switchboard behind the pantry door')
    const record = server.requests.find(r => r.method === 'POST' && r.path === '/rest/v1/attachments')
    const uploads = server.requests.filter(r => r.method === 'POST' && r.path.startsWith('/storage/v1/object/evidence/'))
    const base = record?.body?.storage_path?.replace(/\.jpg$/, '')
    log('a photo\'s record names the room and its group, in the team\'s own folder under rooms/',
      record?.body?.team_id === TEAM && record.body.room_id === 'r1' && record.body.category === 'general' &&
        new RegExp(`^${TEAM}/rooms/r1/[0-9a-f-]{36}\\.jpg$`).test(record.body.storage_path), JSON.stringify(record?.body))
    log('…and its full-quality file beside the display copy', record?.body?.original_path === `${base}-original.jpg`)
    log('with its description, and never a date of its own: the database sets it',
      record?.body?.caption === 'Switchboard behind the pantry door' && !('taken_at' in record.body) && !('created_by' in record.body))
    log('the display copy goes up after the record, then the full-quality file',
      uploads.length === 2 && uploads[0].path.endsWith(`${base}.jpg`) && uploads[1].path.endsWith(`${base}-original.jpg`) &&
        server.requests.indexOf(record) < server.requests.indexOf(uploads[0]))
    log('…each the file it should be', server.files.get(`${base}.jpg`)?.length === 9 && server.files.get(`${base}-original.jpg`)?.length === 45)
    log('it comes back with its id, group, both paths, description and date',
      added.value?.roomId === 'r1' && added.value.category === 'general' && added.value.path === `${base}.jpg` &&
        added.value.originalPath === `${base}-original.jpg` && added.value.takenAt === server.rows[0].taken_at, JSON.stringify(added))

    const long = await api('addRoomPhoto', TEAM, 'r1', '$files', 'issue', 'x'.repeat(320))
    log('a description is cut to 300 characters', long.value?.caption.length === 300)

    server.failUpload = 'original'
    server.requests = []
    const failed = await api('addRoomPhoto', TEAM, 'r1', '$files', 'general', '')
    server.failUpload = null
    const halfway = server.requests.find(r => r.method === 'POST' && r.path.startsWith('/storage/v1/object/evidence/'))?.path.slice('/storage/v1/object/evidence/'.length)
    log('a full-quality file that fails to upload takes the display copy and the record with it',
      !!failed.error && server.rows.length === 2 && !server.files.has(halfway) &&
        posts().some(r => r.method === 'DELETE' && r.path === '/storage/v1/object/evidence') &&
        posts().some(r => r.method === 'DELETE' && r.path === '/rest/v1/attachments'), JSON.stringify(failed))
    server.failUpload = 'display'
    const failedFirst = await api('addRoomPhoto', TEAM, 'r1', '$files', 'general', '')
    server.failUpload = null
    log('…and a display copy that fails takes the record', !!failedFirst.error && server.rows.length === 2)

    server.refuse = true
    server.requests = []
    const refusedPhoto = await api('addRoomPhoto', TEAM, 'r1', '$files', 'general', '')
    server.refuse = false
    log('the database\'s refusal comes back with its code, and nothing is uploaded',
      refusedPhoto.error?.code === 'PT402' && refusedPhoto.error.hint === 'upgrade' &&
        !server.requests.some(r => r.path.startsWith('/storage/v1/object/evidence/')))

    const orphan = await api('addRoomPhoto', TEAM, 'gone-room', '$files', 'general', '')
    log('a room that isn\'t in the database says so, with the code for it', orphan.error?.code === '23503', JSON.stringify(orphan.error))

    // ── Reading ─────────────────────────────────────────────────────────────
    server.as = PAT
    await api('addRoomPhoto', TEAM, 'r1', '$files', 'issue', 'Pat\'s photo')
    server.as = ME
    await api('addRoomPhoto', TEAM, 'r2', '$files', 'general', 'Another room')
    const list = (await api('listRoomPhotos', TEAM, 'r1')).value ?? []
    log('a room\'s photos, newest first, only its own',
      list.length === 3 && list[0].caption === 'Pat\'s photo' && list.every((p, i) => i === 0 || p.takenAt <= list[i - 1].takenAt), JSON.stringify(list.map(p => p.caption)))
    log('each with its group, both files, and who added it',
      list[0].category === 'issue' && list[2].category === 'general' && list.every(p => p.originalPath?.endsWith('-original.jpg')) &&
        list[0].uploader === 'pat@sparky.test' && list[0].createdBy === PAT && list[1].uploader === 'me@sparky.test')
    const of = (await api('roomPhotosOf', TEAM, ['r1', 'r2', 'r3'])).value ?? {}
    log('a report\'s rooms in one request, oldest first',
      of.r1?.length === 3 && of.r1[0].caption === 'Switchboard behind the pantry door' && of.r2?.length === 1 && !of.r3)
    const links = (await api('photoUrls', list.map(p => p.path))).value ?? {}
    log('links to look at them, in one request', list.every(p => /token=t1/.test(links[p.path] ?? '')))

    // ── Describing, moving, downloading ─────────────────────────────────────
    server.requests = []
    await api('setRoomPhotoCaption', list[0].id, 'y'.repeat(310))
    const patch = server.requests.find(r => r.method === 'PATCH')
    log('a description is changed in place, cut to 300', patch?.search.includes(`id=eq.${list[0].id}`) && patch.body.caption.length === 300 && Object.keys(patch.body).length === 1)
    server.requests = []
    await api('setRoomPhotoCategory', list[2].id, 'issue')
    const moved = server.requests.find(r => r.method === 'PATCH')
    log('a photo moves to Issues by its group alone',
      JSON.stringify(moved?.body) === '{"category":"issue"}' && server.rows.find(r => r.id === list[2].id)?.category === 'issue')
    server.requests = []
    const link = (await api('originalPhotoUrl', list[2], 'Acme Corp Kitchen General 2026-11-10.jpg')).value ?? ''
    const signed = server.requests.find(r => r.method === 'POST' && r.path.startsWith('/storage/v1/object/sign/evidence/'))
    log('a download link is for the full-quality file, not the display copy',
      signed?.path === `/storage/v1/object/sign/evidence/${list[2].originalPath}` && link.includes(list[2].originalPath.split('/').pop()), signed?.path)
    log('…named for the client, room, group and date', /download=Acme(%20|\+)Corp(%20|\+)Kitchen(%20|\+)General(%20|\+)2026-11-10\.jpg/.test(link), link)
    const fallback = (await api('originalPhotoUrl', { path: `${TEAM}/rooms/r1/old.jpg`, originalPath: null }, 'x.jpg')).value ?? ''
    log('…and a photo with no full-quality file gives its display copy', fallback.includes('/rooms/r1/old.jpg'))

    // ── Deleting ────────────────────────────────────────────────────────────
    const victim = list[1]
    server.failRemove = true
    const kept = await api('deleteRoomPhoto', victim)
    server.failRemove = false
    log('a photo whose files can\'t be removed keeps its record', !!kept.error && server.rows.some(r => r.id === victim.id))
    server.requests = []
    await api('deleteRoomPhoto', victim)
    const removeAt = at(r => r.method === 'DELETE' && r.path === '/storage/v1/object/evidence')
    const dropAt = at(r => r.method === 'DELETE' && r.path === '/rest/v1/attachments')
    log('deleting a photo removes both its files, then its record',
      removeAt >= 0 && dropAt > removeAt && JSON.stringify(server.requests[removeAt].body.prefixes) === JSON.stringify([victim.path, victim.originalPath]) &&
        !server.files.has(victim.path) && !server.files.has(victim.originalPath) && !server.rows.some(r => r.id === victim.id))

    // ── A room, floor, site or client that goes takes its files first ───────
    const r1Files = server.rows.filter(r => r.room_id === 'r1').flatMap(r => [r.storage_path, r.original_path])
    server.requests = []
    await api('deleteRoom', 'r1')
    const filesAt = at(r => r.method === 'DELETE' && r.path === '/storage/v1/object/evidence')
    const roomAt = at(r => r.method === 'DELETE' && r.path === '/rest/v1/rooms')
    log('deleting a room removes both files of each of its photos, then the room',
      filesAt >= 0 && roomAt > filesAt && r1Files.length === 4 && r1Files.every(p => !server.files.has(p)) &&
        r1Files.every(p => server.requests[filesAt].body.prefixes.includes(p)))
    log('and its records go with it', !server.rows.some(r => r.room_id === 'r1') && server.rows.some(r => r.room_id === 'r2'))

    server.rooms.set('r1', 'f1')
    await api('addRoomPhoto', TEAM, 'r3', '$files', 'general', 'On the second floor')
    const f1Files = server.rows.filter(r => r.room_id === 'r2').flatMap(r => [r.storage_path, r.original_path])
    await api('deleteFloor', 'f1')
    log('deleting a floor removes its rooms\' photo files', f1Files.length === 2 && f1Files.every(p => !server.files.has(p)) && server.rows.length === 1)
    const l2Files = server.rows.flatMap(r => [r.storage_path, r.original_path])
    server.requests = []
    await api('deleteClient', 'c1')
    log('deleting a client removes the photo files at all its sites, first',
      l2Files.length === 2 && l2Files.every(p => !server.files.has(p)) && server.rows.length === 0 &&
        at(r => r.path === '/storage/v1/object/evidence') < at(r => r.method === 'DELETE' && r.path === '/rest/v1/clients'))
    reset()
    await api('addRoomPhoto', TEAM, 'r3', '$files', 'issue', '')
    await api('deleteLocation', 'l2')
    log('deleting a site removes its photo files too', server.files.size === 0 && server.rows.length === 0)

    server.failRemove = true
    await api('addRoomPhoto', TEAM, 'r1', '$files', 'general', '')
    const stuck = await api('deleteRoom', 'r1')
    server.failRemove = false
    log('a room whose photo files can\'t be removed isn\'t deleted yet (the save queue tries again)', !!stuck.error && server.rooms.has('r1'))

    // ── Who has room photos ─────────────────────────────────────────────────
    reset()
    log('a team that has room photos is told so', (await api('roomPhotosAllowed', TEAM)).value === true)
    log('…and its entitlements say so', (await api('getEntitlements', TEAM)).value?.roomPhotos === true)
    server.allowed = false
    log('a team that hasn\'t, isn\'t', (await api('roomPhotosAllowed', TEAM)).value === false && (await api('getEntitlements', TEAM)).value?.roomPhotos === false)
    server.allowed = true

    // ── Before 0022 ─────────────────────────────────────────────────────────
    server.missing = true
    log('before 0022, no team has room photos', (await api('roomPhotosAllowed', TEAM)).value === false)
    log('…its entitlements still read, saying so', (await api('getEntitlements', TEAM)).value?.roomPhotos === false)
    log('…a room has no photos to list (null, not an error)', (await api('listRoomPhotos', TEAM, 'r1')).value === null)
    log('…nor a report', JSON.stringify((await api('roomPhotosOf', TEAM, ['r1'])).value) === '{}')
    server.requests = []
    const plain = await api('deleteRoom', 'r1')
    log('…and deleting a room works as it always did',
      !plain.error && !server.rooms.has('r1') && !server.requests.some(r => r.path.startsWith('/storage/')), JSON.stringify(plain))
    server.missing = false

    // ── Full quality ────────────────────────────────────────────────────────
    console.log('\n— Full quality')
    const quality = (bytes, type, options) =>
      page.evaluate(
        async ({ b64, type, options }) => {
          const { fullQualityJpeg } = await import('/src/lib/photo.js')
          const file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'IMG.x', { type })
          const out = await fullQualityJpeg(file, options)
          if (!out.ok) return out
          const bytes = new Uint8Array(await out.blob.arrayBuffer())
          let s = ''
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          return { ok: true, reduced: out.reduced, type: out.blob.type, same: out.blob === file, b64: btoa(s) }
        },
        { b64: bytes.toString('base64'), type, options },
      )
    const camera = await picture(2400, 1800, 'image/jpeg', 0.92)
    const asTaken = await quality(camera, 'image/jpeg')
    log('a camera\'s JPEG under 10 MB is kept exactly as it was taken',
      asTaken.ok && asTaken.same && !asTaken.reduced && Buffer.from(asTaken.b64, 'base64').equals(camera))
    const png = await picture(2400, 1800, 'image/png')
    const fromPng = await quality(png, 'image/png')
    const pngSize = jpegSize(Buffer.from(fromPng.b64 ?? '', 'base64'))
    log('a PNG becomes a JPEG at full resolution, not reduced',
      fromPng.ok && fromPng.type === 'image/jpeg' && pngSize?.w === 2400 && pngSize.h === 1800 && !fromPng.reduced, JSON.stringify(pngSize))
    const tight = await quality(camera, 'image/jpeg', { limit: 150_000 })
    const tightBytes = Buffer.from(tight.b64 ?? '', 'base64')
    log('one too big for the bucket becomes the largest JPEG that fits, and says it was reduced',
      tight.ok && tight.reduced && tightBytes.length <= 150_000 && jpegSize(tightBytes)?.w < 2400, `${tightBytes.length} bytes, ${JSON.stringify(jpegSize(tightBytes))}`)
    const notPhoto = await quality(Buffer.from('hello'), 'text/plain')
    log('a file that isn\'t a photo is refused', notPhoto.ok === false && /isn't a photo/.test(notPhoto.error))

    // ═════════════════════════════════════════════════════════════════════════
    // The Photos section, on the room during a visit and in the site's editor
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n— On the room during a visit')
    reset()
    const small = await picture(800, 600)
    // One already there, added by Pat.
    server.rows.push({
      id: 'seed-1', team_id: TEAM, room_id: 'r1', category: 'general', caption: 'Meter box, east wall',
      storage_path: `${TEAM}/rooms/r1/seed-1.jpg`, original_path: `${TEAM}/rooms/r1/seed-1-original.jpg`,
      taken_at: '2026-11-09T23:30:00.000Z', created_by: PAT,
    })
    server.files.set(`${TEAM}/rooms/r1/seed-1.jpg`, small)
    server.files.set(`${TEAM}/rooms/r1/seed-1-original.jpg`, camera)

    const SEED = [{
      id: 'c1', name: 'Acme Corp',
      locations: [{
        id: 'l1', address: '1 George St', suburb: 'Sydney', city: 'Sydney', state: 'NSW', postcode: '2000',
        floors: [{ id: 'f1', label: 'Ground', rooms: [{ id: 'r1', name: 'Kitchen', planNumber: '' }, { id: 'r2', name: 'Lounge', planNumber: '' }] }],
        visits: [],
      }],
    }]
    const ENTITLEMENTS = {
      enforced: false, accountType: 'provider', plan: 'free', isPro: false, seatLimit: 1, seatsUsed: 1,
      visitLimit: 1, visitsUsed: 0, packs: ['core', 'av'], pastDueUntil: null,
      cancelAt: null, importUsed: false, openVisits: 0, starterPack: 'av', starterInUse: false, roomPhotos: true,
    }
    await page.evaluate(seed => {
      localStorage.setItem('fc.clients', JSON.stringify(seed))
      localStorage.removeItem('fc.templates')
    }, SEED)
    const openTeam = entitlements =>
      page.evaluate(
        async ({ team, e }) => {
          const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
          const mod = await import(url ?? '/src/lib/entitlements.js')
          await mod.openEntitlements(team, 'user', { getEntitlements: async () => e })
        },
        { team: TEAM, e: entitlements },
      )
    let started = false
    const openSite = async (entitlements = ENTITLEMENTS) => {
      await page.goto(BASE + '#/maintenance', { waitUntil: 'networkidle' })
      await page.reload({ waitUntil: 'networkidle' })
      if (entitlements) await openTeam(entitlements)
      await page.locator('tbody tr').filter({ hasText: 'Acme Corp' }).click()
      await page.locator('tbody tr').filter({ hasText: '1 George St' }).click()
      if (!started) {
        await page.getByRole('button', { name: /^Start PM$/ }).click()
        started = true
      }
    }
    const openKitchen = async (entitlements = ENTITLEMENTS) => {
      await openSite(entitlements)
      await page.getByRole('button', { name: /^Kitchen/ }).first().click()
    }
    const section = () => page.getByRole('region', { name: 'Photos of Kitchen' })
    const group = id => page.getByRole('group', { name: `${id} photos of Kitchen` })
    const text = async (where = section()) => ((await where.count()) ? await where.textContent() : '')

    await openKitchen()
    log('the room has a Photos section, in two groups', await until(async () => /General1 of 20/.test(await text()) && /Issues0 of 20/.test(await text())), await text())
    log('showing the photo already there, through a short-lived link',
      await until(async () => /token=t1/.test((await group('General').getByRole('img').first().getAttribute('src')) ?? '')))
    log('with its description, and when and by whom it was added',
      (await group('General').getByRole('textbox').first().inputValue()) === 'Meter box, east wall' &&
        /Added 10 Nov 2026 by pat@sparky\.test/.test(await text(group('General'))), await text(group('General')))

    // ── Several at once, into the group chosen ──────────────────────────────
    server.requests = []
    const big = await picture(2400, 1800, 'image/jpeg', 0.92)
    await page.getByLabel('Choose photos of Kitchen for General').setInputFiles([
      { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big },
      { name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: small },
    ])
    log('two photos chosen for General both go in there', await until(async () => /General3 of 20/.test(await text())), await text())
    const added2 = server.rows.filter(r => r.id !== 'seed-1')
    log('…recorded as General', added2.length === 2 && added2.every(r => r.category === 'general'))
    const sizes = added2.map(r => jpegSize(server.files.get(r.storage_path) ?? Buffer.alloc(0)))
    log('each display copy made small: 1600 × 1200 from 2400 × 1800, 800 × 600 kept',
      sizes.some(s => s?.w === 1600 && s.h === 1200) && sizes.some(s => s?.w === 800 && s.h === 600), JSON.stringify(sizes))
    log('…and each full-quality file is the photo exactly as it was taken',
      added2.some(r => server.files.get(r.original_path)?.equals(big)) && added2.some(r => server.files.get(r.original_path)?.equals(small)))
    await page.getByLabel('Take a photo of Kitchen for Issues').setInputFiles({ name: 'IMG_0003.jpg', mimeType: 'image/jpeg', buffer: small })
    log('a photo taken for Issues goes in Issues', await until(async () => /Issues1 of 20/.test(await text())) &&
      server.rows.filter(r => r.category === 'issue').length === 1)
    await section().screenshot({ path: `${DIR}/room-photos.png` })

    // ── A description, saved when the box is left ────────────────────────────
    server.requests = []
    const box = group('General').getByRole('textbox').first()
    await box.fill('New switchboard, installed today')
    log('nothing is saved while typing', !server.requests.some(r => r.method === 'PATCH'))
    await box.blur()
    log('leaving the box saves the description',
      await until(() => server.requests.some(r => r.method === 'PATCH' && r.body?.caption === 'New switchboard, installed today')))
    log('the box takes at most 300 characters', (await box.getAttribute('maxlength')) === '300')

    // ── Full size ──────────────────────────────────────────────────────────
    await group('General').getByRole('button', { name: /full size/ }).first().click()
    const viewer = page.getByRole('dialog', { name: 'Photo of Kitchen' })
    log('a photo opens full size, with its description and group',
      (await viewer.count()) === 1 && /New switchboard, installed today/.test(await viewer.textContent()) && /General · Added/.test(await viewer.textContent()))
    await viewer.getByRole('button', { name: 'Close the photo' }).click()
    log('and closes again', (await viewer.count()) === 0)

    // ── Moving between groups ───────────────────────────────────────────────
    server.requests = []
    await group('General').getByRole('button', { name: 'Move to Issues' }).first().click()
    log('a photo moves from General to Issues', await until(async () => /General2 of 20/.test(await text()) && /Issues2 of 20/.test(await text())) &&
      server.requests.some(r => r.method === 'PATCH' && r.body?.category === 'issue'))
    await group('Issues').getByRole('button', { name: 'Move to General' }).first().click()
    log('…and back', await until(async () => /General3 of 20/.test(await text()) && /Issues1 of 20/.test(await text())))

    // ── Download ───────────────────────────────────────────────────────────
    const seedName = 'Acme Corp Kitchen General 2026-11-10.jpg'
    const downloading = page.waitForEvent('download', { timeout: 10000 })
    await group('General').getByRole('button', { name: /^Download the photo added 10 Nov 2026/ }).last().click()
    const downloaded = await downloading
    log('Download gives the full-quality file, named for the client, room, group and date',
      downloaded.suggestedFilename() === seedName && readFileSync(await downloaded.path()).equals(camera), downloaded.suggestedFilename())

    // ── Deleting, after asking ───────────────────────────────────────────────
    server.requests = []
    await group('General').getByRole('button', { name: /^Delete the photo/ }).last().click()
    const confirm = page.getByRole('dialog', { name: 'Delete this photo?' })
    log('deleting asks first', (await confirm.count()) === 1 && server.requests.length === 0)
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    log('Cancel keeps it', server.rows.some(r => r.id === 'seed-1'))
    await group('General').getByRole('button', { name: /^Delete the photo/ }).last().click()
    await page.getByRole('dialog', { name: 'Delete this photo?' }).getByRole('button', { name: 'Delete photo' }).click()
    log('Delete photo removes both files, then the record',
      await until(async () => /General2 of 20/.test(await text())) && !server.files.has(`${TEAM}/rooms/r1/seed-1.jpg`) &&
        !server.files.has(`${TEAM}/rooms/r1/seed-1-original.jpg`) && !server.rows.some(r => r.id === 'seed-1') &&
        at(r => r.path === '/storage/v1/object/evidence') < at(r => r.method === 'DELETE' && r.path === '/rest/v1/attachments'))

    // ── Up to 20 a group ───────────────────────────────────────────────────
    for (let i = 0; i < 17; i++) {
      server.clock += 60_000
      const p = `${TEAM}/rooms/r1/more-${i}.jpg`
      server.rows.push({ id: `more-${i}`, team_id: TEAM, room_id: 'r1', category: 'general', storage_path: p, original_path: null, caption: '', taken_at: new Date(server.clock).toISOString(), created_by: ME })
      server.files.set(p, small)
    }
    await openKitchen()
    await until(async () => /General19 of 20/.test(await text()))
    server.requests = []
    await page.getByLabel('Choose photos of Kitchen for General').setInputFiles([1, 2, 3].map(n => ({ name: `IMG_10${n}.jpg`, mimeType: 'image/jpeg', buffer: small })))
    log('a group holds up to 20: of three chosen, one goes in', await until(async () => /General20 of 20/.test(await text())) &&
      server.requests.filter(r => r.method === 'POST' && r.path === '/rest/v1/attachments').length === 1)
    log('and it says the other two weren\'t added', /2 photos weren't added: General holds up to 20/.test(await text()))
    log('then adding to General is switched off, but not to Issues',
      await group('General').getByRole('button', { name: 'Choose photos for General' }).isDisabled() &&
        !(await group('Issues').getByRole('button', { name: 'Choose photos for Issues' }).isDisabled()))
    log('…and nothing can be moved into a full General', await group('Issues').getByRole('button', { name: 'Move to General' }).first().isDisabled())

    // ── The database says no ─────────────────────────────────────────────────
    server.rows = server.rows.filter(r => !r.id.startsWith('more-'))
    await openKitchen()
    await until(async () => /General3 of 20/.test(await text()))
    server.refuse = true
    server.requests = []
    await page.getByLabel('Take a photo of Kitchen for Issues').setInputFiles({ name: 'IMG_2001.jpg', mimeType: 'image/jpeg', buffer: small })
    log('a refusal gets the upgrade sheet', await until(async () => (await page.getByRole('dialog').count()) === 1 && /Photos are part of Pro/.test(await page.getByRole('dialog').textContent())))
    log('…and nothing is uploaded', !server.requests.some(r => r.path.startsWith('/storage/v1/object/evidence/')))
    await page.getByRole('dialog').getByRole('button', { name: /Not now|Close/ }).click()
    server.refuse = false

    // ── No signal ────────────────────────────────────────────────────────────
    await ctx.setOffline(true)
    server.requests = []
    await page.getByLabel('Choose photos of Kitchen for General').setInputFiles({ name: 'IMG_3001.jpg', mimeType: 'image/jpeg', buffer: small })
    log('with no signal it says photos need a connection', await until(async () => /need a connection/.test((await section().getByRole('alert').textContent().catch(() => '')) ?? '')))
    log('and sends nothing', !server.requests.some(r => r.method !== 'GET'))
    await ctx.setOffline(false)

    // ── Not a photo ──────────────────────────────────────────────────────────
    await page.getByLabel('Choose photos of Kitchen for General').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    log('a file that isn\'t a photo is left out, and says so', await until(async () => /notes\.txt: That file isn't a photo/.test(await text())))

    // ── An observer (Phase E) ────────────────────────────────────────────────
    await openKitchen({ ...ENTITLEMENTS, worker: false })
    await until(async () => /General3 of 20/.test(await text()))
    log('an observer sees the photos, and can download them, but not add, move or delete',
      (await section().getByRole('img').count()) === 4 && (await section().getByRole('button', { name: /^Choose photos/ }).count()) === 0 &&
        (await section().getByRole('button', { name: /^Move to/ }).count()) === 0 && (await section().getByRole('button', { name: /^Delete the photo/ }).count()) === 0 &&
        (await section().getByRole('button', { name: /^Download/ }).count()) === 4 && /You're an observer/.test(await text()))
    log('…nor change a description', (await section().getByRole('textbox').first().getAttribute('readonly')) !== null)

    // ── Who doesn't see it ───────────────────────────────────────────────────
    const noSection = async label => {
      await page.getByRole('heading', { name: 'Comments' }).waitFor()
      await sleep(400)
      log(label, (await section().count()) === 0 && !/Photos/.test(await page.textContent('main')))
    }
    server.requests = []
    await openKitchen({ ...ENTITLEMENTS, roomPhotos: false })
    await noSection('a team without room photos has no Photos section, and no upgrade sheet')
    log('…and nothing is asked about photos', !server.requests.some(r => r.path.includes('attachments')))
    await openKitchen({ ...ENTITLEMENTS, enforced: true, isPro: true, plan: 'pro', roomPhotos: false })
    await noSection('…whatever its plan says, if the database says no')
    server.missing = true
    await openKitchen()
    await noSection('a room whose photos the database can\'t list (no 0022) has none either')
    server.missing = false
    server.requests = []
    await openKitchen(null)
    await noSection('with no team there\'s no Photos section')
    log('…and nothing is asked of the database', !server.requests.some(r => r.path.includes('attachments')))

    // ── The site's room editor ───────────────────────────────────────────────
    console.log('\n— In the site\'s room editor')
    const openEditor = async (entitlements = ENTITLEMENTS) => {
      await page.goto(BASE + '#/edit-client', { waitUntil: 'networkidle' })
      await page.reload({ waitUntil: 'networkidle' })
      await openTeam(entitlements)
      await page.locator('tbody tr').filter({ hasText: 'Acme Corp' }).click()
      await page.locator('tbody tr').filter({ hasText: '1 George St' }).click()
    }
    server.requests = []
    await openEditor()
    const toggle = name => page.getByRole('button', { name: `Photos of ${name}` })
    log('each saved room offers its photos', await until(async () => (await toggle('Kitchen').count()) === 1 && (await toggle('Lounge').count()) === 1))
    log('closed until asked, so a big site doesn\'t load every room\'s photos', !server.requests.some(r => r.search.includes('room_id=eq.')))
    await toggle('Kitchen').click()
    log('opening it shows the room\'s photos, to add to there too',
      await until(async () => /General3 of 20/.test(await text())) && (await section().getByRole('button', { name: 'Choose photos for Issues' }).count()) === 1)
    const offered = await page.getByRole('button', { name: /^Photos of / }).count()
    await page.getByRole('button', { name: 'New Room' }).click()
    await sleep(200)
    log('a new room, still blank, offers none: a blank room isn\'t kept',
      offered === 1 && (await page.getByRole('button', { name: /^Photos of / }).count()) === offered)
    await openEditor({ ...ENTITLEMENTS, roomPhotos: false })
    await sleep(400)
    log('a team without room photos isn\'t offered them in the editor', (await page.getByRole('button', { name: /^Photos of / }).count()) === 0)

    // ── A report's photos, fetched in the browser ────────────────────────────
    console.log('\n— In the report (fetched in the browser)')
    await openTeam(ENTITLEMENTS)
    reset()
    const seedPhoto = (id, room, day, category, caption, file = big) => {
      const p = `${TEAM}/rooms/${room}/${id}.jpg`
      server.rows.push({ id, team_id: TEAM, room_id: room, category, storage_path: p, original_path: `${TEAM}/rooms/${room}/${id}-original.jpg`, caption, taken_at: `${day}T02:00:00.000Z`, created_by: ME })
      if (file) server.files.set(p, file)
    }
    const display = await picture(1600, 1200)
    seedPhoto('a1', 'r1', '2026-11-11', 'general', 'Switchboard behind the pantry door', display)
    seedPhoto('a2', 'r1', '2026-11-12', 'issue', 'Scorched power point', display)
    seedPhoto('a3', 'r1', '2026-11-20', 'general', 'Added after the visit', display)
    seedPhoto('b1', 'r2', '2026-11-11', 'issue', 'Water stain on the ceiling', null) // its file can't be fetched
    const rooms = [{ id: 'r1', name: 'Kitchen' }, { id: 'r2', name: 'Lounge' }]
    const visit = { id: 'v1', startedAt: '2026-11-12T01:00:00.000Z', completedAt: '2026-11-12T05:00:00.000Z' }
    const inPage = (fn, options) =>
      page.evaluate(
        async ({ fn, rooms, visit, options }) => {
          const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/roomPhotoReport.js')).pop()
          const mod = await import(url ?? '/src/lib/roomPhotoReport.js')
          const out = await mod[fn](rooms, visit, options)
          if (!out.bytes) return out
          const b64 = bytes => {
            let s = ''
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
            return btoa(s)
          }
          return { ...out, bytes: Object.fromEntries(Object.entries(out.bytes).map(([id, bytes]) => [id, b64(bytes)])) }
        },
        { fn, rooms, visit, options },
      )
    server.requests = []
    const listed = await inPage('roomPhotosForReport', { withBytes: false })
    log('a report asks for every room\'s photos in one request',
      server.requests.filter(r => r.path === '/rest/v1/attachments').length === 1 && /room_id=in\.\(r1,r2\)/.test(server.requests[0]?.search ?? ''),
      server.requests.map(r => r.path + r.search).join(' | '))
    log('…only those added by the day the visit was completed',
      listed.photos.r1?.map(p => p.id).join() === 'a1,a2' && listed.photos.r2?.length === 1 && !listed.missing, JSON.stringify(listed.photos))
    const counts = await inPage('countReportPhotos')
    log('the photo choice is offered with how many each brings', JSON.stringify(counts) === '{"all":3,"general":1,"issue":2}', JSON.stringify(counts))
    server.requests = []
    const fetched = await inPage('roomPhotosForReport', { withBytes: true })
    const sizeOf = id => jpegSize(Buffer.from(fetched.bytes[id] ?? '', 'base64'))
    log('the PDF\'s photos are made about 1000 px from the display copies: 1000 × 750 from 1600 × 1200',
      sizeOf('a1')?.w === 1000 && sizeOf('a1').h === 750 && sizeOf('a2')?.w === 1000, JSON.stringify([sizeOf('a1'), sizeOf('a2')]))
    log('…never fetching the full-quality files', !server.requests.some(r => r.path.includes('-original') || JSON.stringify(r.body ?? '').includes('-original')))
    log('…not one added after the visit', !('a3' in fetched.bytes))
    log('a photo that can\'t be fetched is left out, and the report says photos are missing', fetched.missing === true && !('b1' in fetched.bytes) && 'a1' in fetched.bytes)
    const onlyGeneral = await inPage('roomPhotosForReport', { withBytes: true, include: 'general' })
    log('General only fetches General', Object.keys(onlyGeneral.bytes).join() === 'a1' && !onlyGeneral.photos.r2 && !onlyGeneral.missing)
    server.requests = []
    const none = await inPage('roomPhotosForReport', { withBytes: true, include: 'none' })
    log('No photos asks for none', JSON.stringify(none.photos) === '{}' && !none.missing && server.requests.length === 0)
    const tightReport = await inPage('roomPhotosForReport', { withBytes: true, budget: 20_000 })
    const tightSize = jpegSize(Buffer.from(tightReport.bytes.a1 ?? '', 'base64'))
    log('a site whose photos would make the PDF too large gets them smaller still', tightSize?.w === 480 && tightSize.h === 360, JSON.stringify(tightSize))
    await ctx.setOffline(true)
    const offlineReport = await inPage('roomPhotosForReport', { withBytes: true })
    await ctx.setOffline(false)
    log('with no signal the report goes without them, and says so', offlineReport.missing === true && JSON.stringify(offlineReport.photos) === '{}')

    // ── Exporting and sending from the visit ─────────────────────────────────
    server.rows = server.rows.filter(r => r.id !== 'a3')
    // The visit started above finishes when it's exported, today: every photo
    // here was added before then.
    await openSite()
    const choice = page.getByRole('dialog', { name: 'Which photos go in the PDF?' })
    const exported = async (button, pick) => {
      const download = page.waitForEvent('download', { timeout: 20000 })
      await page.getByRole('button', { name: button }).click()
      await page.getByRole('dialog').getByRole('button', { name: /Save as a new revision|Replace/ }).first().click({ timeout: 1500 }).catch(() => {})
      if (pick) {
        await choice.waitFor({ timeout: 6000 })
        await choice.getByRole('button', { name: new RegExp(`^${pick}`) }).click()
      }
      return readFileSync(await (await download).path())
    }
    const firstPdf = exported('Export PDF', 'All photos')
    log('"Export PDF" asks which photos go in, with how many each brings',
      await until(async () => (await choice.count()) === 1) && /All photos\s*3/.test(await choice.textContent()) &&
        /General only\s*1/.test(await choice.textContent()) && /Issues only\s*2/.test(await choice.textContent()), await choice.textContent().catch(() => ''))
    await choice.screenshot({ path: `${DIR}/room-photos-choice.png` })
    const allPdf = await read(await firstPdf)
    log('All photos: the rooms\' photos go in, under their groups, with descriptions and dates',
      /Photos — General\nSwitchboard behind the pantry door\nAdded 2026-11-11/.test(allPdf.text) && /Photos — Issues\nScorched power point\nAdded 2026-11-12/.test(allPdf.text) &&
        allPdf.images === 2, allPdf.text.split('\n').slice(-24).join(' | '))
    log('…one it couldn\'t fetch says so in its place', /Photo not included in this copy\nWater stain on the ceiling/.test(allPdf.text))
    log('…and the page says photos are missing', await until(async () => /This PDF is missing photos: they need a connection/.test(await page.textContent('main'))))
    server.files.set(`${TEAM}/rooms/r2/b1.jpg`, display)
    const issuesPdf = await read(await exported('Export PDF', 'Issues only'))
    log('Issues only: just the Issues photos', /Scorched power point/.test(issuesPdf.text) && /Water stain/.test(issuesPdf.text) &&
      !/Switchboard|Photos — General/.test(issuesPdf.text) && issuesPdf.images === 2)
    log('…and nothing is said to be missing', (await page.getByText('This PDF is missing photos').count()) === 0)
    server.requests = []
    const nonePdf = await read(await exported('Export PDF', 'No photos'))
    log('No photos: none, and none fetched', !/Photos —|Switchboard|Scorched/.test(nonePdf.text) && nonePdf.images === 0 &&
      !server.requests.some(r => r.path.startsWith('/storage/v1/object/sign/evidence')))
    const xlsx = exported(/^Export report$/)
    await sleep(800)
    log('"Export report" (Excel) doesn\'t ask', (await choice.count()) === 0)
    const ExcelJS = (await import('exceljs')).default
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(await xlsx)
    const sheet = []
    book.worksheets[0].eachRow(r => sheet.push(`${r.getCell(1).text} | ${r.getCell(2).text}`))
    log('…and its workbook has no photos and no photo list', !/Switchboard|Scorched|Water stain|Photos/.test(sheet.join('\n')))

    server.reports = []
    server.sent = []
    const sendButton = page.getByRole('button', { name: /^Send report$/ })
    log('a finished visit offers to send its report', await until(async () => (await sendButton.count()) >= 1), `${await sendButton.count()} buttons`)
    await sendButton.first().click({ timeout: 5000 })
    const sendDialog = page.getByRole('dialog', { name: 'Send report' })
    await page.getByLabel('Send to').fill('landlord@example.test')
    const submit = sendDialog.getByRole('button', { name: /^Send report$/ })
    log('…and the send dialog takes an address', await until(async () => !(await submit.isDisabled())), (await sendDialog.textContent().catch(() => '')).slice(-200))
    await submit.click({ timeout: 5000 })
    // It has been exported before, so first: a new revision, or a replacement.
    await page.getByRole('dialog').getByRole('button', { name: /Save as a new revision|Replace/ }).first().click({ timeout: 3000 }).catch(() => {})
    log('"Send report" asks which photos go in too', await until(async () => (await choice.count()) === 1))
    await choice.getByRole('button', { name: /^General only/ }).click()
    await until(() => server.reports.length === 1, 15000)
    const sentPdf = server.reports[0] ? await read(server.reports[0]) : { text: '', images: -1 }
    log('…and the PDF sent carries only the chosen group',
      /Photos — General\nSwitchboard behind the pantry door/.test(sentPdf.text) && !/Scorched|Water stain|Photos — Issues/.test(sentPdf.text) && sentPdf.images === 1,
      sentPdf.text.split('\n').slice(-12).join(' | '))
    await until(() => server.sent.length === 1, 6000)
    const keptSnapshot = server.sent[0]?.p_snapshot ?? server.sent[0]?.snapshot
    const keptPhotos = (keptSnapshot?.rooms ?? []).flatMap(r => r.photos ?? [])
    log('…as does the copy of the report kept with it', keptPhotos.length === 1 && keptPhotos[0].category === 'general' && keptPhotos[0].caption === 'Switchboard behind the pantry door',
      JSON.stringify(keptPhotos))
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
