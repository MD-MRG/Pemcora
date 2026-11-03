/**
 * Step C2c: a photo of an item's label, on Pro.
 *
 * In a browser in test mode. Every request off this machine is answered here,
 * as the database and the photo bucket would answer it, or refused: nothing can
 * reach the live project.
 *
 *   node tests/label-photo.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - a photo is made small before it goes: at most 1600 px on its long edge, as
 *     a JPEG
 *   - its record goes first, in the team's own folder, then the file; a file that
 *     fails to upload takes its record with it
 *   - the plan's refusal gets the upgrade sheet, and nothing is uploaded
 *   - with no signal it says it needs a connection, and sends nothing
 *   - with no team, as in local-only mode, it says photos need one
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
const SEED = [
  {
    id: 'c1',
    name: 'Rental Co',
    locations: [
      {
        id: 'l1',
        address: '10 Smith St',
        suburb: 'Toowong',
        city: 'Brisbane',
        state: 'QLD',
        postcode: '4066',
        floors: [{ id: 'f1', label: 'Upstairs', rooms: [{ id: 'b1', name: 'Bedroom 1', planNumber: '', roomType: 'bedroom' }] }],
        assets: [
          {
            id: 'a1', assetType: 'smoke_alarm', roomId: 'b1', label: 'Bedroom 1 alarm', make: '', model: '', serial: '',
            attributes: {}, installedOn: null, expiresOn: null, removedAt: null, createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
        visits: [],
      },
    ],
  },
]

const ENTITLEMENTS = {
  enforced: false, accountType: 'provider', plan: 'free', isPro: false, seatLimit: 1, seatsUsed: 1,
  visitLimit: 1, visitsUsed: 0, packs: ['core', 'qld_electrical'], pastDueUntil: null,
  cancelAt: null, importUsed: false, openVisits: 0, starterPack: 'qld_electrical', starterInUse: false,
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

// ── The stand-in database and photo bucket ──────────────────────────────────
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
const server = { rows: [], requests: [], refuse: false, failUpload: false }
// A 1×1 PNG, for the photo the page shows.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function backend(route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.hostname === localhost) return route.continue()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const path = decodeURIComponent(url.pathname)
  server.requests.push({ method: req.method(), path, search: url.search, type: req.headers()['content-type'], body: req.postDataBuffer() })

  if (path === '/rest/v1/attachments' && req.method() === 'GET') {
    const asset = url.searchParams.get('asset_id')?.replace('eq.', '')
    return json(route, 200, server.rows.filter(r => r.asset_id === asset).slice().reverse())
  }
  if (path === '/rest/v1/attachments' && req.method() === 'POST') {
    if (server.refuse) return json(route, 402, { code: 'PT402', message: 'Photo evidence is part of Pro', hint: 'upgrade', details: null })
    const body = JSON.parse(req.postData())
    const row = { id: `p${server.rows.length + 1}`, ...body, taken_at: '2026-11-03T01:00:00+00:00' }
    server.rows.push(row)
    return json(route, 201, row)
  }
  if (path === '/rest/v1/attachments' && req.method() === 'DELETE') {
    const id = url.searchParams.get('id')?.replace('eq.', '')
    server.rows = server.rows.filter(r => r.id !== id)
    return route.fulfill({ status: 204, headers: cors })
  }
  // Asking for a link is a POST; the page then GETs the photo through it.
  if (path.startsWith('/storage/v1/object/sign/evidence/') && req.method() === 'POST') {
    return json(route, 200, { signedURL: `/object/sign/evidence/${path.slice('/storage/v1/object/sign/evidence/'.length)}?token=t1` })
  }
  if (path.startsWith('/storage/v1/object/sign/evidence/') && url.searchParams.get('token') === 't1') {
    return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: PIXEL })
  }
  if (path.startsWith('/storage/v1/object/evidence/') && req.method() === 'POST') {
    if (server.failUpload) return json(route, 500, { statusCode: '500', error: 'Internal', message: 'Storage is having a bad day' })
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

  // ── Making it small ─────────────────────────────────────────────────────────
  const shrunk = await page.evaluate(async () => {
    const { shrinkPhoto } = await import('/src/lib/photo.js')
    const file = async (w, h) => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d').fillRect(0, 0, w / 2, h / 2)
      return new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'label.png', { type: 'image/png' })
    }
    const out = async f => {
      const r = await shrinkPhoto(f)
      return r.ok ? { w: r.width, h: r.height, type: r.blob.type } : { error: r.error }
    }
    return {
      wide: await out(await file(3000, 1000)),
      tall: await out(await file(1000, 2400)),
      small: await out(await file(800, 600)),
      text: await out(new File(['hello'], 'notes.txt', { type: 'text/plain' })),
      broken: await out(new File(['not really'], 'label.jpg', { type: 'image/jpeg' })),
    }
  })
  log('a wide photo comes down to 1600 px across, as a JPEG', shrunk.wide.w === 1600 && shrunk.wide.h === 533 && shrunk.wide.type === 'image/jpeg', JSON.stringify(shrunk.wide))
  log('a tall one to 1600 px high', shrunk.tall.w === 667 && shrunk.tall.h === 1600)
  log('a small one keeps its size', shrunk.small.w === 800 && shrunk.small.h === 600)
  log('a file that isn\'t a photo is refused', shrunk.text.error === 'That file isn\'t a photo.')
  log('and one that can\'t be read says so', /couldn't be read/.test(shrunk.broken.error ?? ''))

  // A photo as a camera hands it over.
  const camera = Buffer.from(
    await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 2400
      c.height = 1800
      const g = c.getContext('2d')
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`
        g.fillRect((i * 97) % 2400, (i * 53) % 1800, 120, 90)
      }
      const blob = await new Promise(r => c.toBlob(r, 'image/png'))
      return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())))
    }),
    'base64',
  )

  await page.evaluate(seed => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
    localStorage.removeItem('fc.templates')
  }, SEED)
  const openAlarm = async () => {
    await page.goto(BASE + '#/qld-smoke-alarm', { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('tbody tr').filter({ hasText: 'Rental Co' }).click()
    await page.locator('tbody tr').filter({ hasText: '10 Smith St' }).click()
    await page.getByRole('button', { name: 'Edit Bedroom 1 alarm' }).click()
  }
  const openTeam = entitlements =>
    page.evaluate(
      async ({ team, e }) => {
        const url = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
        const mod = await import(url ?? '/src/lib/entitlements.js')
        await mod.openEntitlements(team, 'user', { getEntitlements: async () => e })
      },
      { team: TEAM, e: entitlements },
    )
  const choose = (buffer, name = 'IMG_0001.png', mimeType = 'image/png') =>
    page.getByLabel('Label photo of Bedroom 1 alarm').setInputFiles({ name, mimeType, buffer })

  // ── No team ─────────────────────────────────────────────────────────────────
  await openAlarm()
  log('with no team, photos say they need one', /Label photos are kept with a signed-in team/.test(await page.textContent('main')))
  log('and nothing is asked of the database', server.requests.length === 0, JSON.stringify(server.requests.map(r => r.path)))
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: '+ Add smoke alarm' }).click()
  log('a new item has no photo yet: it isn\'t in the database to point at', (await page.getByText('Label photo').count()) === 0)

  if (!configured) {
    console.log('(the photo checks need VITE_SUPABASE_URL in .env, and were skipped)')
  } else {
    // ── Adding one ──────────────────────────────────────────────────────────────
    await openAlarm()
    await openTeam(ENTITLEMENTS)
    const button = () => page.getByRole('button', { name: /label photo/ })
    log('a team\'s alarm offers a label photo', (await until(async () => (await button().textContent()) === 'Add label photo')))
    log('without saying Pro while the limits are off', !/Label photo\s*Pro/.test(await page.getByRole('form').textContent()))
    server.requests = []
    await choose(camera)
    await until(async () => (await page.getByRole('img', { name: 'Label of Bedroom 1 alarm' }).count()) === 1)
    const record = server.requests.find(r => r.method === 'POST' && r.path === '/rest/v1/attachments')
    const upload = server.requests.find(r => r.method === 'POST' && r.path.startsWith('/storage/v1/object/evidence/'))
    const sent = record && JSON.parse(record.body.toString())
    log('its record names the item, in the team\'s own folder',
      sent?.team_id === TEAM && sent.asset_id === 'a1' && sent.caption === 'Label' &&
        new RegExp(`^${TEAM}/assets/a1/[0-9a-f-]{36}\\.jpg$`).test(sent.storage_path), JSON.stringify(sent))
    log('the file goes to the same place, after the record',
      upload?.path === `/storage/v1/object/evidence/${sent?.storage_path}` &&
        server.requests.indexOf(record) < server.requests.indexOf(upload))
    const body = upload?.body ?? Buffer.alloc(0)
    const size = jpegSize(body)
    log('as a JPEG made small: 1600 × 1200 from the camera\'s 2400 × 1800',
      upload?.type?.startsWith('multipart/form-data') || upload?.type === 'image/jpeg' ? size?.w === 1600 && size.h === 1200 : false,
      `${upload?.type}, ${JSON.stringify(size)}, ${body.length} bytes`)
    const shown = page.getByRole('img', { name: 'Label of Bedroom 1 alarm' })
    log('the photo shows, through a short-lived link',
      /token=t1/.test(await shown.getAttribute('src')) &&
        (await until(() => shown.evaluate(img => img.complete && img.naturalWidth > 0))))
    log('and the button offers to replace it', (await button().textContent()) === 'Replace label photo' && /Taken /.test(await page.getByRole('form').textContent()))
    await page.getByRole('form').screenshot({ path: `${DIR}/label-photo.png` })

    // ── The upload fails ────────────────────────────────────────────────────────
    server.failUpload = true
    server.requests = []
    await choose(camera)
    await until(async () => (await page.getByRole('alert').count()) === 1)
    const removed = server.requests.find(r => r.method === 'DELETE' && r.path === '/rest/v1/attachments')
    log('a file that fails to upload takes its record with it', !!removed && removed.search.includes('id=eq.p2') && server.rows.length === 1)
    log('and says it wasn\'t saved', /The photo wasn't saved/.test(await page.getByRole('alert').textContent()))
    server.failUpload = false

    // ── The plan says no ────────────────────────────────────────────────────────
    server.refuse = true
    server.requests = []
    await choose(camera)
    log('a refusal gets the upgrade sheet', await until(async () => (await page.getByRole('dialog').count()) === 1 && /Photos are part of Pro/.test(await page.getByRole('dialog').textContent())))
    log('saying the item itself is saved', /The item itself is saved without it/.test(await page.getByRole('dialog').textContent()))
    log('and nothing is uploaded', !server.requests.some(r => r.path.startsWith('/storage/v1/object/evidence/')))
    await page.getByRole('dialog').getByRole('button', { name: /Not now|Close/ }).click()
    server.refuse = false

    // ── No signal ───────────────────────────────────────────────────────────────
    await ctx.setOffline(true)
    server.requests = []
    await choose(camera)
    log('with no signal it says it needs a connection', await until(async () => /needs a connection/.test((await page.getByRole('alert').textContent()) ?? '')))
    log('and sends nothing', !server.requests.some(r => r.method === 'POST'))
    await ctx.setOffline(false)

    // ── Not a photo ─────────────────────────────────────────────────────────────
    await choose(Buffer.from('hello'), 'notes.txt', 'text/plain')
    log('a file that isn\'t a photo is refused', await until(async () => /isn't a photo/.test((await page.getByRole('alert').textContent()) ?? '')))

    // ── Once the limits are on ──────────────────────────────────────────────────
    await openAlarm()
    await openTeam({ ...ENTITLEMENTS, enforced: true })
    log('a Free team is told photos are Pro', await until(async () => /Label photo\s*Pro/.test(await page.getByRole('form').textContent())))
    await openTeam({ ...ENTITLEMENTS, enforced: true, plan: 'pro', isPro: true })
    log('a Pro team isn\'t', await until(async () => !/Label photo\s*Pro/.test(await page.getByRole('form').textContent())))
  }
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
