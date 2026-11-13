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
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

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
    server.files.set(path.slice('/storage/v1/object/evidence/'.length), req.postDataBuffer() ?? PIXEL)
    return json(route, 200, { Key: path.slice('/storage/v1/object/'.length) })
  }
  return route.abort()
}

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 } })
  await ctx.route('**/*', backend)
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))

  await page.goto(BASE, { waitUntil: 'networkidle' })
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
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
