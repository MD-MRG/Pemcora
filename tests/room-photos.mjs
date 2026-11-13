/**
 * Room photos (0022): photos kept with a site's room, each with a description
 * and the date it was added.
 *
 * In a browser in test mode. Every request off this machine is answered here,
 * as the database and the photo bucket would answer it, or refused: nothing can
 * reach the live project.
 *
 *   node tests/room-photos.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - the API: a photo's record goes first, in the team's own folder under
 *     rooms/<room>/, then its file; a file that fails to upload takes its record
 *     with it; a deleted photo loses its file, then its record; a deleted room,
 *     floor, site or client loses its photos' files before it goes
 *   - before 0022 is applied, room photos are simply not there, and deleting a
 *     room works as it always did
 *   - the Photos section, on the room during a visit and in the site's room
 *     editor: several photos at once, each made small (1600 px JPEG), newest
 *     first, up to 10 a room; a description saved when its box is left, at most
 *     300 characters; "Added <date> by <who>"; full size; delete after asking
 *   - a refusal gets the upgrade sheet; with no signal it says so and sends
 *     nothing; an observer can look but not change; with no team, or before
 *     0022, there's no section at all
 *   - reports: each room's photos with their description and the day added,
 *     only those added by the day the visit was completed; the PDF embeds them
 *     at about 1000 px (smaller if a big site's would be too large), the Excel
 *     report lists them as "photo in the PDF"; a photo that can't be fetched
 *     leaves the report building, saying so
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
const { buildReportSnapshot, photosAtVisit } = await import('../src/lib/reportSnapshot.js')
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
  return { pages, text: pages.map(p => p.text).join('\n') }
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

const TEAM = '11111111-1111-4111-8111-111111111111'
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MEMBERS = [
  { user_id: ME, email: 'me@sparky.test', role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
  { user_id: PAT, email: 'pat@sparky.test', role: 'member', joined_at: '2026-01-02T00:00:00Z' },
]

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

// ── The stand-in database and photo bucket ──────────────────────────────────
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
// A 1×1 PNG, for a photo the page shows.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const server = {
  rows: [],          // attachments
  files: new Map(),  // evidence bucket: path → bytes
  rooms: new Map(),  // room → floor
  floors: new Map(), // floor → site
  sites: new Map(),  // site → client
  requests: [],
  missing: false,    // 0022 not applied: no attachments.room_id
  refuse: false,     // the plan says no
  failUpload: false,
  failRemove: false,
  as: ME,
  clock: Date.parse('2026-11-10T00:00:00Z'),
}
const reset = () => {
  Object.assign(server, { rows: [], files: new Map(), requests: [], missing: false, refuse: false, failUpload: false, failRemove: false, as: ME })
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
      if (server.refuse) return json(route, 402, { code: 'PT402', message: 'Photo evidence is part of Pro', hint: 'upgrade', details: null })
      if (body.room_id && !server.rooms.has(body.room_id)) {
        return json(route, 403, { code: '42501', message: 'new row violates row-level security policy for table "attachments"', details: null, hint: null })
      }
      server.clock += 60_000
      // As 0022 does: the server's date and the signed-in person, whatever was sent.
      const row = { id: `p${server.rows.length + 1}-${server.clock}`, caption: '', ...body, taken_at: new Date(server.clock).toISOString(), created_by: server.as }
      server.rows.push(row)
      return json(route, 201, single ? row : [row])
    }
    if (method === 'PATCH') {
      const hit = server.rows.filter(r => matches(r, params))
      for (const r of hit) Object.assign(r, { caption: body.caption ?? r.caption })
      return json(route, 200, hit)
    }
    if (method === 'DELETE') {
      server.rows = server.rows.filter(r => !matches(r, params))
      return route.fulfill({ status: 204, headers: cors })
    }
  }
  if (path === '/rest/v1/rpc/team_members_list') return json(route, 200, MEMBERS)

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

  // ── the evidence bucket ──
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
    return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: cors, body: bytes })
  }
  if (path === '/storage/v1/object/evidence' && method === 'DELETE') {
    if (server.failRemove) return json(route, 500, { statusCode: '500', error: 'Internal', message: 'Storage is having a bad day' })
    for (const p of body.prefixes) server.files.delete(p)
    return json(route, 200, body.prefixes.map(name => ({ name })))
  }
  if (path.startsWith('/storage/v1/object/evidence/') && method === 'POST') {
    if (server.failUpload) return json(route, 500, { statusCode: '500', error: 'Internal', message: 'Storage is having a bad day' })
    // A Blob goes up as a form; keep the JPEG inside it, as the bucket does.
    const sent = req.postDataBuffer() ?? PIXEL
    const start = sent.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
    const end = sent.lastIndexOf(Buffer.from([0xff, 0xd9]))
    server.files.set(path.slice('/storage/v1/object/evidence/'.length), start >= 0 && end > start ? sent.subarray(start, end + 2) : sent)
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
  // A JPEG of w × h, made by the browser, as bytes.
  const picture = (w, h) =>
    page
      .evaluate(
        async ({ w, h }) => {
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          const g = c.getContext('2d')
          for (let i = 0; i < 300; i++) {
            g.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`
            g.fillRect((i * 97) % w, (i * 53) % h, w / 20, h / 20)
          }
          const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9))
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let s = ''
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          return btoa(s)
        },
        { w, h },
      )
      .then(b64 => Buffer.from(b64, 'base64'))

  // ═══════════════════════════════════════════════════════════════════════════
  // Reports, in Node: the snapshot, the PDF and the workbook
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
      { id: 'k2', caption: 'Switchboard behind the pantry door', takenAt: '2026-11-12T03:00:00+00:00' },
      { id: 'k1', caption: '', takenAt: '2026-11-01T22:00:00+00:00' },
      { id: 'k3', caption: 'Later that evening', takenAt: '2026-11-12T23:30:00+00:00' },
      { id: 'k4', caption: 'Added the next week', takenAt: '2026-11-19T01:00:00+00:00' },
    ],
    r2: [{ id: 'l1', caption: 'Water stain on the ceiling', takenAt: '2026-11-10T00:00:00+00:00' }],
  }
  const byVisit = photosAtVisit(PHOTOS.r1, VISIT)
  log('a report shows the photos added by the day the visit was completed, oldest first',
    byVisit.map(p => p.id).join() === 'k1,k2,k3', byVisit.map(p => p.id).join())
  log('…and a visit still open shows them all', photosAtVisit(PHOTOS.r1, { ...VISIT, completedAt: null }).length === 4)
  const snap = buildReportSnapshot({ client: { name: 'Acme Corp' }, visit: VISIT, rooms: ROOMS, roomPhotos: PHOTOS })
  log('the snapshot gives each room its photos, described and dated',
    JSON.stringify(snap.rooms[0].photos) === JSON.stringify([
      { id: 'k1', caption: '', addedOn: '2026-11-01' },
      { id: 'k2', caption: 'Switchboard behind the pantry door', addedOn: '2026-11-12' },
      { id: 'k3', caption: 'Later that evening', addedOn: '2026-11-12' },
    ]) && snap.rooms[1].photos?.[0]?.caption === 'Water stain on the ceiling', JSON.stringify(snap.rooms.map(r => r.photos)))
  log('…and a room without photos reads as it always did (no photos key)',
    !('photos' in snap.rooms[2]) && !('photos' in buildReportSnapshot({ visit: VISIT, rooms: ROOMS }).rooms[0]))

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
  log('…the photos themselves, under the room they belong to',
    pdf.pages.reduce((n, p) => n + p.images, 0) === 3 && plainPdf.pages.reduce((n, p) => n + p.images, 0) === 0 &&
      /Room 1: Kitchen[^]*Photos[^]*Room 2: Lounge[^]*Not tested during this visit[^]*Photos[^]*Water stain/.test(pdf.text))
  log('…a photo that couldn\'t be fetched says so in its place', /Photo not included in this copy\nLater that evening/.test(pdf.text))
  log('…and nothing added after the visit was completed', !/Added the next week/.test(pdf.text))
  log('a room with no photos has no Photos heading, as before', !/Room 3: Laundry[^]*Photos/.test(pdf.text) && !/Photos/.test(plainPdf.text))

  const wb = await buildWorkbook({ ...pdfArgs, location: { address: '1 George St' }, roomPhotos: PHOTOS })
  const rows = []
  wb.worksheets[0].eachRow(r => rows.push([r.getCell(1).text, r.getCell(2).text]))
  const cells = rows.map(r => r.join(' | ')).join('\n')
  log('the Excel report lists each photo\'s description and date, with "photo in the PDF"',
    /Switchboard behind the pantry door \| Added 2026-11-12 · photo in the PDF/.test(cells) &&
      /No description \| Added 2026-11-01 · photo in the PDF/.test(cells) && /Water stain on the ceiling \| Added 2026-11-10 · photo in the PDF/.test(cells), cells.slice(-400))
  log('…under the room, and not the one added after', /Room 1: Kitchen[^]*Photos[^]*Room 2: Lounge/.test(cells) && !/Added the next week/.test(cells))

  const configured = await page.evaluate(async () => (await import('/src/lib/supabase.js')).isSupabaseConfigured)
  if (!configured) {
    console.log('(the room photo checks need VITE_SUPABASE_URL in .env, and were skipped)')
  } else {
    // Runs an api.js function in the page; a thrown error comes back as { error }.
    const api = (name, ...args) =>
      page.evaluate(
        async ({ name, args }) => {
          const mod = await import('/src/lib/api.js')
          try {
            const blobbed = args.map(a => (a === '$blob' ? new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }) : a))
            return { value: (await mod[name](...blobbed)) ?? null }
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
    const added = await api('addRoomPhoto', TEAM, 'r1', '$blob', 'Switchboard behind the pantry door')
    const record = server.requests.find(r => r.method === 'POST' && r.path === '/rest/v1/attachments')
    const upload = server.requests.find(r => r.method === 'POST' && r.path.startsWith('/storage/v1/object/evidence/'))
    log('a photo\'s record names the room, in the team\'s own folder under rooms/',
      record?.body?.team_id === TEAM && record.body.room_id === 'r1' &&
        new RegExp(`^${TEAM}/rooms/r1/[0-9a-f-]{36}\\.jpg$`).test(record.body.storage_path), JSON.stringify(record?.body))
    log('with its description', record?.body?.caption === 'Switchboard behind the pantry door')
    log('and never a date of its own: the database sets it', record && !('taken_at' in record.body) && !('created_by' in record.body))
    log('the file goes to the same place, after the record',
      upload?.path === `/storage/v1/object/evidence/${record?.body?.storage_path}` && server.requests.indexOf(record) < server.requests.indexOf(upload))
    log('it comes back with its id, path, description and date',
      added.value?.roomId === 'r1' && added.value.path === record?.body?.storage_path && added.value.caption === 'Switchboard behind the pantry door' &&
        added.value.takenAt === server.rows[0].taken_at, JSON.stringify(added))

    const long = await api('addRoomPhoto', TEAM, 'r1', '$blob', 'x'.repeat(320))
    log('a description is cut to 300 characters', long.value?.caption.length === 300)

    server.failUpload = true
    server.requests = []
    const failed = await api('addRoomPhoto', TEAM, 'r1', '$blob', '')
    server.failUpload = false
    log('a file that fails to upload takes its record with it',
      !!failed.error && server.rows.length === 2 && posts().some(r => r.method === 'DELETE' && r.path === '/rest/v1/attachments'), JSON.stringify(failed))

    server.refuse = true
    server.requests = []
    const refusedPhoto = await api('addRoomPhoto', TEAM, 'r1', '$blob', '')
    server.refuse = false
    log('the plan\'s refusal comes back with its code, and nothing is uploaded',
      refusedPhoto.error?.code === 'PT402' && refusedPhoto.error.hint === 'upgrade' &&
        !server.requests.some(r => r.path.startsWith('/storage/v1/object/evidence/')))

    const orphan = await api('addRoomPhoto', TEAM, 'gone-room', '$blob', '')
    log('a room that isn\'t in the database says so, with the code for it', orphan.error?.code === '23503', JSON.stringify(orphan.error))

    // ── Reading ─────────────────────────────────────────────────────────────
    server.as = PAT
    await api('addRoomPhoto', TEAM, 'r1', '$blob', 'Pat\'s photo')
    server.as = ME
    await api('addRoomPhoto', TEAM, 'r2', '$blob', 'Another room')
    const list = (await api('listRoomPhotos', TEAM, 'r1')).value ?? []
    log('a room\'s photos, newest first, only its own',
      list.length === 3 && list[0].caption === 'Pat\'s photo' && list.every((p, i) => i === 0 || p.takenAt <= list[i - 1].takenAt), JSON.stringify(list.map(p => p.caption)))
    log('each with who added it', list[0].uploader === 'pat@sparky.test' && list[0].createdBy === PAT && list[1].uploader === 'me@sparky.test')
    const of = (await api('roomPhotosOf', TEAM, ['r1', 'r2', 'r3'])).value ?? {}
    log('a report\'s rooms in one request, oldest first',
      of.r1?.length === 3 && of.r1[0].caption === 'Switchboard behind the pantry door' && of.r2?.length === 1 && !of.r3)
    const links = (await api('photoUrls', list.map(p => p.path))).value ?? {}
    log('links to look at them, in one request', list.every(p => /token=t1/.test(links[p.path] ?? '')))

    // ── Describing ──────────────────────────────────────────────────────────
    server.requests = []
    await api('setRoomPhotoCaption', list[0].id, 'y'.repeat(310))
    const patch = server.requests.find(r => r.method === 'PATCH')
    log('a description is changed in place, cut to 300', patch?.search.includes(`id=eq.${list[0].id}`) && patch.body.caption.length === 300 && Object.keys(patch.body).length === 1)

    // ── Deleting ────────────────────────────────────────────────────────────
    const victim = list[1]
    server.files.set(victim.path, PIXEL)
    server.failRemove = true
    const kept = await api('deleteRoomPhoto', victim)
    server.failRemove = false
    log('a photo whose file can\'t be removed keeps its record', !!kept.error && server.rows.some(r => r.id === victim.id))
    server.requests = []
    await api('deleteRoomPhoto', victim)
    const removeAt = at(r => r.method === 'DELETE' && r.path === '/storage/v1/object/evidence')
    const dropAt = at(r => r.method === 'DELETE' && r.path === '/rest/v1/attachments')
    log('deleting a photo removes its file, then its record',
      removeAt >= 0 && dropAt > removeAt && server.requests[removeAt].body.prefixes[0] === victim.path &&
        !server.files.has(victim.path) && !server.rows.some(r => r.id === victim.id))

    // ── A room, floor, site or client that goes takes its files first ───────
    for (const r of server.rows) server.files.set(r.storage_path, PIXEL)
    const r1Files = server.rows.filter(r => r.room_id === 'r1').map(r => r.storage_path)
    server.requests = []
    await api('deleteRoom', 'r1')
    const filesAt = at(r => r.method === 'DELETE' && r.path === '/storage/v1/object/evidence')
    const roomAt = at(r => r.method === 'DELETE' && r.path === '/rest/v1/rooms')
    log('deleting a room removes its photos\' files, then the room',
      filesAt >= 0 && roomAt > filesAt && r1Files.length === 2 && r1Files.every(p => !server.files.has(p)) &&
        r1Files.every(p => server.requests[filesAt].body.prefixes.includes(p)))
    log('and its records go with it', !server.rows.some(r => r.room_id === 'r1') && server.rows.some(r => r.room_id === 'r2'))

    server.rooms.set('r1', 'f1')
    await api('addRoomPhoto', TEAM, 'r3', '$blob', 'On the second floor')
    for (const r of server.rows) server.files.set(r.storage_path, PIXEL)
    const f1Files = server.rows.filter(r => r.room_id === 'r2').map(r => r.storage_path)
    await api('deleteFloor', 'f1')
    log('deleting a floor removes its rooms\' photo files', f1Files.length === 1 && !server.files.has(f1Files[0]) && server.rows.length === 1)
    const l2Files = server.rows.map(r => r.storage_path)
    server.requests = []
    await api('deleteClient', 'c1')
    log('deleting a client removes the photo files at all its sites, first',
      l2Files.length === 1 && !server.files.has(l2Files[0]) && server.rows.length === 0 &&
        at(r => r.path === '/storage/v1/object/evidence') < at(r => r.method === 'DELETE' && r.path === '/rest/v1/clients'))
    reset()
    await api('addRoomPhoto', TEAM, 'r3', '$blob', '')
    server.files.set(server.rows[0].storage_path, PIXEL)
    await api('deleteLocation', 'l2')
    log('deleting a site removes its photo files too', server.files.size === 0 && server.rows.length === 0)

    server.failRemove = true
    await api('addRoomPhoto', TEAM, 'r1', '$blob', '')
    const stuck = await api('deleteRoom', 'r1')
    server.failRemove = false
    log('a room whose photo files can\'t be removed isn\'t deleted yet (the save queue tries again)', !!stuck.error && server.rooms.has('r1'))

    // ── Before 0022 ─────────────────────────────────────────────────────────
    reset()
    server.missing = true
    log('before 0022, a room has no photos to list (null, not an error)', (await api('listRoomPhotos', TEAM, 'r1')).value === null)
    log('…nor a report', JSON.stringify((await api('roomPhotosOf', TEAM, ['r1'])).value) === '{}')
    log('…and the app can tell', (await api('roomPhotosReady', TEAM)).value === false)
    server.requests = []
    const plain = await api('deleteRoom', 'r1')
    log('…and deleting a room works as it always did',
      !plain.error && !server.rooms.has('r1') && !server.requests.some(r => r.path.startsWith('/storage/')), JSON.stringify(plain))
    server.missing = false
    log('after 0022 the app can tell too', (await api('roomPhotosReady', TEAM)).value === true)

    // ═════════════════════════════════════════════════════════════════════════
    // The Photos section, on the room during a visit and in the site's editor
    // ═════════════════════════════════════════════════════════════════════════
    console.log('\n— On the room during a visit')
    reset()
    // A photo as a camera hands it over, and a second one to go with it.
    const camera = await picture(2400, 1800)
    const small = await picture(800, 600)
    // One already there, added by Pat.
    server.rows.push({
      id: 'seed-1', team_id: TEAM, room_id: 'r1', storage_path: `${TEAM}/rooms/r1/seed-1.jpg`, caption: 'Meter box, east wall',
      taken_at: '2026-11-09T23:30:00.000Z', created_by: PAT,
    })
    server.files.set(`${TEAM}/rooms/r1/seed-1.jpg`, small)

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
      cancelAt: null, importUsed: false, openVisits: 0, starterPack: 'av', starterInUse: false,
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
    const openKitchen = async (entitlements = ENTITLEMENTS) => {
      await page.goto(BASE + '#/maintenance', { waitUntil: 'networkidle' })
      await page.reload({ waitUntil: 'networkidle' })
      await openTeam(entitlements)
      await page.locator('tbody tr').filter({ hasText: 'Acme Corp' }).click()
      await page.locator('tbody tr').filter({ hasText: '1 George St' }).click()
      if (!started) {
        await page.getByRole('button', { name: /^Start PM$/ }).click()
        started = true
      }
      await page.getByRole('button', { name: /^Kitchen/ }).first().click()
    }
    const section = () => page.getByRole('region', { name: 'Photos of Kitchen' })
    const text = async () => ((await section().count()) ? await section().textContent() : '')

    await openKitchen()
    log('the room has a Photos section', await until(async () => /1 of 10/.test(await text())), await text())
    log('showing the photo already there, through a short-lived link',
      await until(async () => /token=t1/.test((await section().getByRole('img').first().getAttribute('src')) ?? '')))
    log('with its description, and when and by whom it was added',
      (await section().getByRole('textbox').first().inputValue()) === 'Meter box, east wall' &&
        /Added 10 Nov 2026 by pat@sparky\.test/.test(await text()), await text())
    log('without saying Pro while the limits are off', !/Photos\s*Pro/.test(await text()))

    // ── Several at once ───────────────────────────────────────────────────────
    server.requests = []
    await page.getByLabel('Choose photos of Kitchen').setInputFiles([
      { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: camera },
      { name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: small },
    ])
    log('two photos chosen at once both go in', await until(async () => /3 of 10/.test(await text())), await text())
    const uploads = server.requests.filter(r => r.method === 'POST' && r.path.startsWith('/storage/v1/object/evidence/'))
    const sizes = server.rows.filter(r => r.id !== 'seed-1').map(r => jpegSize(server.files.get(r.storage_path) ?? Buffer.alloc(0)))
    log('each made small first: 1600 × 1200 from the camera\'s 2400 × 1800, 800 × 600 kept',
      uploads.length === 2 && sizes.some(s => s?.w === 1600 && s.h === 1200) && sizes.some(s => s?.w === 800 && s.h === 600), JSON.stringify(sizes))
    log('newest first, each with its own description box', (await section().getByRole('textbox').count()) === 3 &&
      (await section().getByRole('textbox').last().inputValue()) === 'Meter box, east wall')
    await section().screenshot({ path: `${DIR}/room-photos.png` })

    // ── A description, saved when the box is left ────────────────────────────
    server.requests = []
    const box = section().getByRole('textbox').first()
    await box.fill('New switchboard, installed today')
    log('nothing is saved while typing', !server.requests.some(r => r.method === 'PATCH'))
    await box.blur()
    log('leaving the box saves the description',
      await until(() => server.requests.some(r => r.method === 'PATCH' && r.body?.caption === 'New switchboard, installed today')))
    log('the box takes at most 300 characters', (await box.getAttribute('maxlength')) === '300')

    // ── Full size ──────────────────────────────────────────────────────────
    await section().getByRole('button', { name: /full size/ }).first().click()
    const viewer = page.getByRole('dialog', { name: 'Photo of Kitchen' })
    log('a photo opens full size, with its description',
      (await viewer.count()) === 1 && /New switchboard, installed today/.test(await viewer.textContent()) && (await viewer.getByRole('img').count()) === 1)
    await viewer.getByRole('button', { name: 'Close the photo' }).click()
    log('and closes again', (await viewer.count()) === 0)

    // ── Deleting, after asking ───────────────────────────────────────────────
    server.requests = []
    await section().getByRole('button', { name: /^Delete the photo/ }).last().click()
    const confirm = page.getByRole('dialog', { name: 'Delete this photo?' })
    log('deleting asks first', (await confirm.count()) === 1 && server.requests.length === 0)
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    log('Cancel keeps it', server.rows.some(r => r.id === 'seed-1'))
    await section().getByRole('button', { name: /^Delete the photo/ }).last().click()
    await page.getByRole('dialog', { name: 'Delete this photo?' }).getByRole('button', { name: 'Delete photo' }).click()
    log('Delete photo removes the file, then the record',
      await until(async () => /2 of 10/.test(await text())) && !server.files.has(`${TEAM}/rooms/r1/seed-1.jpg`) && !server.rows.some(r => r.id === 'seed-1') &&
        at(r => r.path === '/storage/v1/object/evidence') < at(r => r.method === 'DELETE' && r.path === '/rest/v1/attachments'))

    // ── Up to 10 ───────────────────────────────────────────────────────────
    for (let i = 0; i < 7; i++) {
      server.clock += 60_000
      const p = `${TEAM}/rooms/r1/more-${i}.jpg`
      server.rows.push({ id: `more-${i}`, team_id: TEAM, room_id: 'r1', storage_path: p, caption: '', taken_at: new Date(server.clock).toISOString(), created_by: ME })
      server.files.set(p, small)
    }
    await openKitchen()
    await until(async () => /9 of 10/.test(await text()))
    server.requests = []
    await page.getByLabel('Choose photos of Kitchen').setInputFiles([1, 2, 3].map(n => ({ name: `IMG_10${n}.jpg`, mimeType: 'image/jpeg', buffer: small })))
    log('a room holds up to 10: of three chosen, one goes in', await until(async () => /10 of 10/.test(await text())) &&
      server.requests.filter(r => r.method === 'POST' && r.path === '/rest/v1/attachments').length === 1)
    log('and it says the other two weren\'t added', /2 photos weren't added: a room holds up to 10/.test(await text()))
    log('then adding is switched off', await section().getByRole('button', { name: 'Choose photos' }).isDisabled() &&
      await section().getByRole('button', { name: 'Take a photo' }).isDisabled())

    // ── The plan says no ─────────────────────────────────────────────────────
    server.rows = server.rows.filter(r => !r.id.startsWith('more-'))
    await openKitchen()
    await until(async () => /3 of 10/.test(await text()))
    server.refuse = true
    server.requests = []
    await page.getByLabel('Take a photo of Kitchen').setInputFiles({ name: 'IMG_2001.jpg', mimeType: 'image/jpeg', buffer: camera })
    log('a refusal gets the upgrade sheet', await until(async () => (await page.getByRole('dialog').count()) === 1 && /Photos are part of Pro/.test(await page.getByRole('dialog').textContent())))
    log('saying the room is saved without them', /The room itself is saved without them/.test(await page.getByRole('dialog').textContent()))
    log('and nothing is uploaded', !server.requests.some(r => r.path.startsWith('/storage/v1/object/evidence/')))
    await page.getByRole('dialog').getByRole('button', { name: /Not now|Close/ }).click()
    server.refuse = false

    // ── No signal ────────────────────────────────────────────────────────────
    await ctx.setOffline(true)
    server.requests = []
    await page.getByLabel('Choose photos of Kitchen').setInputFiles({ name: 'IMG_3001.jpg', mimeType: 'image/jpeg', buffer: small })
    log('with no signal it says photos need a connection', await until(async () => /need a connection/.test((await section().getByRole('alert').textContent().catch(() => '')) ?? '')))
    log('and sends nothing', !server.requests.some(r => r.method !== 'GET'))
    await ctx.setOffline(false)

    // ── Not a photo ──────────────────────────────────────────────────────────
    await page.getByLabel('Choose photos of Kitchen').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    log('a file that isn\'t a photo is left out, and says so', await until(async () => /notes\.txt: That file isn't a photo/.test(await text())))

    // ── Once the limits are on ────────────────────────────────────────────────
    await openKitchen({ ...ENTITLEMENTS, enforced: true })
    log('a Free team is told photos are Pro', await until(async () => /Photos\s*Pro/.test(await text())))
    await openKitchen({ ...ENTITLEMENTS, enforced: true, plan: 'pro', isPro: true })
    log('a Pro team isn\'t', await until(async () => /3 of 10/.test(await text())) && !/Photos\s*Pro/.test(await text()))

    // ── An observer (Phase E) ────────────────────────────────────────────────
    await openKitchen({ ...ENTITLEMENTS, worker: false })
    await until(async () => /3 of 10/.test(await text()))
    log('an observer sees the photos but can\'t add or delete them',
      (await section().getByRole('img').count()) === 3 && (await section().getByRole('button', { name: 'Choose photos' }).count()) === 0 &&
        (await section().getByRole('button', { name: /^Delete the photo/ }).count()) === 0 && /You're an observer/.test(await text()))
    log('nor change a description', (await section().getByRole('textbox').first().getAttribute('readonly')) !== null)

    // ── Before 0022 ──────────────────────────────────────────────────────────
    server.missing = true
    await openKitchen()
    await page.getByRole('heading', { name: 'Comments' }).waitFor()
    await sleep(500)
    log('before 0022 is applied, the room has no Photos section', (await section().count()) === 0 && !/Photos/.test(await page.textContent('main')))
    server.missing = false

    // ── With no team, as in local-only mode ───────────────────────────────────
    await page.goto(BASE + '#/maintenance', { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    server.requests = []
    await page.locator('tbody tr').filter({ hasText: 'Acme Corp' }).click()
    await page.locator('tbody tr').filter({ hasText: '1 George St' }).click()
    await page.getByRole('button', { name: /^Kitchen/ }).first().click()
    await page.getByRole('heading', { name: 'Comments' }).waitFor()
    log('with no team there\'s no Photos section, and nothing is asked of the database',
      (await section().count()) === 0 && !server.requests.some(r => r.path.includes('attachments')))

    // ── The site's room editor ───────────────────────────────────────────────
    console.log('\n— In the site\'s room editor')
    const openEditor = async (entitlements = ENTITLEMENTS) => {
      await page.goto(BASE + '#/edit-client', { waitUntil: 'networkidle' })
      await page.reload({ waitUntil: 'networkidle' })
      await openTeam(entitlements)
      await page.locator('tbody tr').filter({ hasText: 'Acme Corp' }).click()
      await page.locator('tbody tr').filter({ hasText: '1 George St' }).click()
    }
    await openEditor()
    const toggle = name => page.getByRole('button', { name: `Photos of ${name}` })
    log('each saved room offers its photos', await until(async () => (await toggle('Kitchen').count()) === 1 && (await toggle('Lounge').count()) === 1))
    log('closed until asked, so a big site doesn\'t load every room\'s photos', !server.requests.some(r => r.search.includes('room_id=eq.')))
    await toggle('Kitchen').click()
    log('opening it shows the room\'s photos, to add to there too',
      await until(async () => /3 of 10/.test(await text())) && (await section().getByRole('button', { name: 'Choose photos' }).count()) === 1)
    const offered = await page.getByRole('button', { name: /^Photos of / }).count()
    await page.getByRole('button', { name: 'New Room' }).click()
    await sleep(200)
    log('a new room, still blank, offers none: a blank room isn\'t kept',
      offered === 1 && (await page.getByRole('button', { name: /^Photos of / }).count()) === offered)
    server.missing = true
    await openEditor()
    await sleep(500)
    log('before 0022, the editor offers no photos', (await page.getByRole('button', { name: /^Photos of / }).count()) === 0)
    server.missing = false

    // ── A report's photos, fetched in the browser ────────────────────────────
    console.log('\n— In the report (fetched in the browser)')
    reset()
    const big = await picture(1600, 1200)
    const seedPhoto = (id, room, day, caption, file = big) => {
      const p = `${TEAM}/rooms/${room}/${id}.jpg`
      server.rows.push({ id, team_id: TEAM, room_id: room, storage_path: p, caption, taken_at: `${day}T02:00:00.000Z`, created_by: ME })
      if (file) server.files.set(p, file)
    }
    seedPhoto('a1', 'r1', '2026-11-11', 'Switchboard behind the pantry door')
    seedPhoto('a2', 'r1', '2026-11-12', 'Meter box, east wall')
    seedPhoto('a3', 'r1', '2026-11-20', 'Added after the visit')
    seedPhoto('b1', 'r2', '2026-11-11', 'Water stain on the ceiling', null) // its file can't be fetched
    const rooms = [{ id: 'r1', name: 'Kitchen' }, { id: 'r2', name: 'Lounge' }]
    const visit = { id: 'v1', startedAt: '2026-11-12T01:00:00.000Z', completedAt: '2026-11-12T05:00:00.000Z' }
    const forReport = options =>
      page.evaluate(
        async ({ rooms, visit, options }) => {
          const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/roomPhotoReport.js')).pop()
          const mod = await import(url ?? '/src/lib/roomPhotoReport.js')
          const out = await mod.roomPhotosForReport(rooms, visit, options)
          const b64 = bytes => {
            let s = ''
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
            return btoa(s)
          }
          return { ...out, bytes: Object.fromEntries(Object.entries(out.bytes).map(([id, bytes]) => [id, b64(bytes)])) }
        },
        { rooms, visit, options },
      )
    server.requests = []
    const listed = await forReport({ withBytes: false })
    log('the Excel report asks for every room\'s photos in one request, and not the photos',
      server.requests.filter(r => r.path === '/rest/v1/attachments').length === 1 && /room_id=in\.\(r1,r2\)/.test(server.requests[0]?.search ?? '') &&
        !server.requests.some(r => r.path.startsWith('/storage/')), server.requests.map(r => r.path + r.search).join(' | '))
    log('…only those added by the day the visit was completed',
      listed.photos.r1?.map(p => p.id).join() === 'a1,a2' && listed.photos.r2?.length === 1 && !listed.missing, JSON.stringify(listed.photos))
    const fetched = await forReport({ withBytes: true })
    const sizeOf = id => jpegSize(Buffer.from(fetched.bytes[id] ?? '', 'base64'))
    log('the PDF\'s photos are made about 1000 px: 1000 × 750 from 1600 × 1200',
      sizeOf('a1')?.w === 1000 && sizeOf('a1').h === 750 && sizeOf('a2')?.w === 1000, JSON.stringify([sizeOf('a1'), sizeOf('a2')]))
    log('…not one added after the visit', !('a3' in fetched.bytes))
    log('a photo that can\'t be fetched is left out, and the report says photos are missing', fetched.missing === true && !('b1' in fetched.bytes) && 'a1' in fetched.bytes)
    const tight = await forReport({ withBytes: true, budget: 20_000 })
    const tightSize = jpegSize(Buffer.from(tight.bytes.a1 ?? '', 'base64'))
    log('a site whose photos would make the PDF too large gets them smaller still', tightSize?.w === 480 && tightSize.h === 360, JSON.stringify(tightSize))
    await ctx.setOffline(true)
    const offlineReport = await forReport({ withBytes: true })
    await ctx.setOffline(false)
    log('with no signal the report goes without them, and says so', offlineReport.missing === true && JSON.stringify(offlineReport.photos) === '{}')

    // ── Exporting from the visit ─────────────────────────────────────────────
    server.rows = server.rows.filter(r => r.id !== 'a3')
    // The visit started above finishes when it's exported, today: every photo
    // here was added before then.
    await openKitchen()
    await page.getByRole('button', { name: /^List$/ }).click()
    const exported = async name => {
      const download = page.waitForEvent('download', { timeout: 20000 })
      await page.getByRole('button', { name }).click()
      await page.getByRole('dialog').getByRole('button', { name: /Save as a new revision|Replace/ }).first().click({ timeout: 1500 }).catch(() => {})
      return readFileSync(await (await download).path())
    }
    const visitPdf = await read(await exported('Export PDF'))
    log('"Export PDF" puts the rooms\' photos in, with their descriptions and dates',
      /Switchboard behind the pantry door\nAdded 2026-11-11/.test(visitPdf.text) && /Meter box, east wall\nAdded 2026-11-12/.test(visitPdf.text) &&
        visitPdf.pages.reduce((n, p) => n + p.images, 0) === 2, visitPdf.text.split('\n').slice(-24).join(' | '))
    log('…one it couldn\'t fetch says so in its place', /Photo not included in this copy\nWater stain on the ceiling/.test(visitPdf.text))
    log('…and the page says photos are missing', await until(async () => /This PDF is missing photos: they need a connection/.test(await page.textContent('main'))))
    server.files.set(`${TEAM}/rooms/r2/b1.jpg`, big)
    const fullPdf = await read(await exported('Export PDF'))
    log('with every photo there, the PDF has them all and the page says nothing is missing',
      fullPdf.pages.reduce((n, p) => n + p.images, 0) === 3 && !/Photo not included/.test(fullPdf.text) &&
        (await page.getByText('This PDF is missing photos').count()) === 0)
    const xlsx = await exported(/^Export report$/)
    const ExcelJS = (await import('exceljs')).default
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(xlsx)
    const sheet = []
    book.worksheets[0].eachRow(r => sheet.push(`${r.getCell(1).text} | ${r.getCell(2).text}`))
    log('"Export report" lists each photo\'s description and date, "photo in the PDF"',
      sheet.includes('Switchboard behind the pantry door | Added 2026-11-11 · photo in the PDF') &&
        sheet.includes('Water stain on the ceiling | Added 2026-11-11 · photo in the PDF'), sheet.slice(-12).join(' / '))
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
