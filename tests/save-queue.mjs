/**
 * The save queue: cache.js and the Supabase adapter, on bad days (build plan B3).
 *
 * Not a browser suite. The real cache, adapter and client store run in Node against
 * a stand-in for the database (fake-server.mjs) that keeps its rules and can lose
 * connections on demand. tests/offline.mjs drives the same thing through the real
 * screens, with real device storage and two browsers.
 *
 * What it holds the app to:
 *   - nothing entered is lost: not to a dropped connection, a reload, or an edit
 *     made while a save was running
 *   - a save can be repeated safely when its answer goes missing
 *   - a visit the database refuses stops there, and everything else keeps saving
 *   - two devices on one visit end up with both devices' answers, counted once
 *
 * And it classifies failures as the real Supabase client reports them, since that
 * decides whether work is retried or set aside.
 */
import { createClient } from '@supabase/supabase-js'
import { FakeServer, memoryDevice } from './fake-server.mjs'

const log = (k, v, extra = '') =>
  console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const cache = await import('../src/lib/cache.js')
const store = await import('../src/lib/clientStore.js')
const { supabaseAdapter } = await import('../src/lib/adapters/supabase.js')
const { classifySaveError } = await import('../src/lib/saveErrors.js')
const { deepEqual, mergeRoom, mergeSite, mergeVisit } = await import('../src/lib/visitMerge.js')

const { flush, hydrate, resetCache, saveStatus, heldVisits, readClients, writeClients } = cache

const USER = 'user'
const TEAM = 'team'

const TEMPLATE = {
  mainLabel: 'Main test list',
  tests: [
    { id: 't1', label: 'One', order: 0 },
    { id: 't2', label: 'Two', order: 1 },
    { id: 't3', label: 'Three', order: 2 },
  ],
  sections: [],
}

const answers = (main, extra = {}) => ({
  template: TEMPLATE,
  results: { main },
  sections: {},
  troubleshooting: {},
  comments: '',
  ...extra,
})

async function boot(server, device = memoryDevice(), options = {}) {
  resetCache()
  await hydrate(supabaseAdapter(TEAM, USER, server.api), { device, ...options })
  return device
}

function setup() {
  const server = new FakeServer()
  server.seedClient()
  return server
}

const localVisit = id =>
  readClients()
    .flatMap(c => c.locations)
    .flatMap(l => l.visits ?? [])
    .find(v => v.id === id)

const addClient = (id, name) =>
  writeClients([...readClients(), { id, name, locations: [] }])

const start = () => store.beginVisit('c1', 'l1', 'maintenance', 'Sam')
const saveRoom = (visitId, roomId, patch) => store.saveRoomEntry('c1', 'l1', visitId, roomId, patch)

// ── Edits made while a save is running ──────────────────────────────────────
{
  const server = setup()
  await boot(server)
  const release = server.hold('createClient')
  addClient('c2', 'First')
  const running = flush()
  addClient('c3', 'Second')
  const asked = flush()
  log('a second save asked for mid-push waits its turn', asked === running)
  release()
  await running
  log('an edit made during a save still reaches the database',
    server.clients.some(c => c.id === 'c3'), server.clients.map(c => c.id).join())
  log('and only then does it say saved', saveStatus() === 'saved', saveStatus())
}

// ── A save that lands with its answer lost, sent again ──────────────────────
for (const step of ['createClient', 'addLocation', 'addFloor', 'addRoom', 'startVisit', 'saveVisitRoom', 'recordExport']) {
  const server = new FakeServer()
  await boot(server)
  const visitId = crypto.randomUUID()
  writeClients([
    {
      id: 'c9',
      name: 'New client',
      locations: [
        {
          id: 'l9',
          address: '1 High St',
          suburb: 'Town',
          floors: [{ id: 'f9', label: 'Ground', rooms: [{ id: 'r9', name: 'Lobby' }] }],
          visits: [
            {
              id: visitId,
              kind: 'maintenance',
              technician: 'Sam',
              startedAt: new Date().toISOString(),
              completedAt: null,
              rooms: { r9: answers({ t1: 'PASS' }) },
              exports: [{ revision: 1, filename: 'report.xlsx' }],
            },
          ],
        },
      ],
    },
  ])
  server.loseAnswer(step)
  const first = await flush()
  const second = await flush()
  const location = server.clients[0]?.locations[0]
  const visits = [...server.visits.values()]
  log(`an answer lost after ${step} is repeated without a duplicate or a jam`,
    first === false && second === true && saveStatus() === 'saved' &&
      server.clients.length === 1 && location?.floors.length === 1 && location.floors[0].rooms.length === 1 &&
      visits.length === 1 && server.counted === 1 && visits[0].rooms.r9?.results.main.t1 === 'PASS' && visits[0].exports.length === 1,
    `first=${first} second=${second} status=${saveStatus()} counted=${server.counted}`)
}

// ── A dropped connection ─────────────────────────────────────────────────────
{
  const server = setup()
  const device = await boot(server)
  server.down = true
  addClient('c2', 'While down')
  log('with no connection the save reports failure', (await flush()) === false)
  log('and says offline, not failed', saveStatus() === 'offline', saveStatus())
  const copy = device.copies.get(device.ownId)
  log('the change is on the device, marked unsent',
    copy?.unsaved === true && copy.data.clients.some(c => c.id === 'c2'))
  log('and has not been counted as sent', !copy.snapshot.clients.some(c => c.id === 'c2'))
  server.down = false
  log('when the connection returns it goes', (await flush()) === true && server.clients.some(c => c.id === 'c2'))
  log('and the status says so', saveStatus() === 'saved' && !cache.hasUnsavedWork())
  log('the device copy no longer says unsent', device.copies.get(device.ownId).unsaved === false)
}

// ── A reload ─────────────────────────────────────────────────────────────────
{
  const server = setup()
  const device = await boot(server)
  server.down = true
  const { visit } = await start()
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS' }))

  // Reloaded with no connection: the device copy is what there is.
  await boot(server, device)
  log('a reload with no connection comes back on the device copy',
    localVisit(visit.id)?.rooms.r1?.results.main.t1 === 'PASS')
  log('and says offline', saveStatus() === 'offline', saveStatus())
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS', t2: 'FAIL' }))

  // Reloaded with the connection back: it is sent, then the database is read.
  server.down = false
  server.seedClient({ id: 'c5', name: 'From another device', locationId: 'l5' })
  await boot(server, device)
  const sent = server.visits.get(visit.id)
  log('a reload with the connection back sends unsaved work first',
    sent?.rooms.r1?.results.main.t2 === 'FAIL', JSON.stringify(sent?.rooms.r1?.results))
  log('and then reads what other devices did',
    readClients().some(c => c.id === 'c5'), readClients().map(c => c.id).join())
  log('what it just sent is still there', localVisit(visit.id)?.rooms.r1?.results.main.t2 === 'FAIL')
  log('nothing is left to send', !cache.hasUnsavedWork() && (await flush()) === true)
  log('the visit counted once through all of it', server.counted === 1, `${server.counted}`)
}

// ── A slow connection doesn't hold the technician at a spinner ──────────────
{
  const server = setup()
  const device = await boot(server)
  addClient('c2', 'Kept on the device')
  await flush()
  const release = server.hold('listClients')
  const before = Date.now()
  await boot(server, device, { patience: 30 })
  log('a slow load gives up waiting and runs on the device copy',
    Date.now() - before < 2000 && readClients().some(c => c.id === 'c2'))
  log('without claiming to be saving for ever', saveStatus() === 'saved', saveStatus())
  addClient('c3', 'Typed while it loads')
  release()
  await new Promise(r => setTimeout(r, 20))
  log('and a late answer does not overwrite the work', readClients().some(c => c.id === 'c3'))
  await flush()
}
{
  const server = setup()
  const device = await boot(server)
  addClient('c2', 'Kept on the device')
  await flush()
  const release = server.hold('listClients')
  await boot(server, device, { patience: 30 })
  server.seedClient({ id: 'c5', name: 'From another device', locationId: 'l5' })
  const seen = cache.outsideChanges()
  release()
  await new Promise(r => setTimeout(r, 30))
  log('with nothing touched, a late answer is still used', readClients().some(c => c.id === 'c5'), readClients().map(c => c.id).join())
  log('and whatever is open is told to read again', cache.outsideChanges() === seen + 1)
  log('leaving nothing to send', !cache.hasUnsavedWork() && saveStatus() === 'saved')
}

// ── One refusal doesn't stop the rest ───────────────────────────────────────
{
  const server = setup()
  await boot(server)
  addClient('c2', 'Equinix') // the name is taken
  addClient('c3', 'Fine')
  await flush()
  log('a client that will not save does not stop the next one',
    server.clients.some(c => c.id === 'c3') && !server.clients.some(c => c.id === 'c2'))
  log('it says Save failed, with the reason',
    saveStatus() === 'failed' && /already exists/.test(cache.saveError()?.message), cache.saveError()?.message)
  log('and keeps what was entered', readClients().some(c => c.id === 'c2'))
  writeClients(readClients().map(c => (c.id === 'c2' ? { ...c, name: 'Equinix 2' } : c)))
  log('correcting it lets it through', (await flush()) === true && server.clients.some(c => c.name === 'Equinix 2'))
  log('and the failure clears', saveStatus() === 'saved', saveStatus())
}
{
  const server = setup()
  const device = await boot(server)
  addClient('c2', 'Equinix')
  await flush()
  await boot(server, device)
  log('a client still refused survives a reload', readClients().some(c => c.id === 'c2'))
  log('and the rest comes from the database', readClients().some(c => c.id === 'c1'))
  log('it still says Save failed', saveStatus() === 'failed', saveStatus())
}

// ── A plain member ──────────────────────────────────────────────────────────
{
  const server = setup()
  server.admin = false
  await boot(server)
  cache.writeTemplates({ maintenance: TEMPLATE }) // the first read seeds an empty list
  const { visit } = await start()
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS' }))
  log('a plain member seeding a list is no failure', (await flush()) === true && saveStatus() === 'saved')
  log('and their field work saves', server.visits.get(visit.id)?.rooms.r1?.results.main.t1 === 'PASS')

  cache.writeSettings({ company: { name: 'Mine' }, plate: 'brass' })
  await flush()
  log('a member changing branding is told', saveStatus() === 'failed' && /admin/.test(cache.saveError()?.message), saveStatus())
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS', t2: 'PASS' }))
  log('without it being sent again and again, or stopping field work',
    (await flush()) === true && server.visits.get(visit.id)?.rooms.r1?.results.main.t2 === 'PASS')
}

// ── Starting a visit ────────────────────────────────────────────────────────
{
  const server = setup()
  await boot(server)
  const started = await start()
  log('online, the database has the visit before it opens',
    started.outcome === 'started' && server.visits.has(started.visit.id) && !!localVisit(started.visit.id))
  log('nothing is left to send afterwards', !cache.hasUnsavedWork())
  await flush()
  log('and it is not sent a second time', server.countCalls('startVisit') === 1 && server.counted === 1)
  log('asking again gives the same visit', (await start()).visit.id === started.visit.id)
}
{
  const server = setup()
  await boot(server)
  addClient('c2', 'Just added')
  writeClients(
    readClients().map(c =>
      c.id === 'c2'
        ? { ...c, locations: [{ id: 'l2', address: '2 New St', suburb: 'Town', floors: [], visits: [] }] }
        : c,
    ),
  )
  const started = await store.beginVisit('c2', 'l2', 'maintenance', 'Sam')
  log('a site added seconds ago goes first, so the visit has something to hang off',
    started.outcome === 'started' && server.visits.has(started.visit.id))
}
{
  const server = setup()
  server.visitLimit = 0
  await boot(server)
  const started = await start()
  log('refused online: nothing opens', started.outcome === 'refused' && started.reason === 'upgrade' && !store.openVisit('c1', 'l1', 'maintenance'),
    JSON.stringify(started))
  log('and there is nothing waiting to fail on every save', !cache.hasUnsavedWork() && (await flush()) === true)
  log('with the database\'s reason to show', /inspection/.test(started.message), started.message)
}
{
  const server = setup()
  await boot(server)
  const release = server.hold('startVisit')
  const visit = { id: crypto.randomUUID(), kind: 'maintenance', technician: '', startedAt: new Date().toISOString() }
  const answer = await cache.startOnServer('l1', visit, 20)
  log('no answer in time counts as offline', answer.outcome === 'offline')
  release()
}

// ── A visit started offline ─────────────────────────────────────────────────
{
  const server = setup()
  await boot(server)
  server.down = true
  const started = await start()
  log('offline, the visit opens anyway', started.outcome === 'offline' && !!store.openVisit('c1', 'l1', 'maintenance'))
  saveRoom(started.visit.id, 'r1', answers({ t1: 'FAIL' }, { troubleshooting: { t1: 'Noted' } }))
  server.down = false
  await flush()
  const saved = server.visits.get(started.visit.id)
  log('and is checked and saved when the device reconnects',
    saved?.rooms.r1?.troubleshooting.t1 === 'Noted' && server.counted === 1)
}

// ── A refused offline start ─────────────────────────────────────────────────
{
  const server = setup()
  const device = await boot(server)
  server.down = true
  const { visit } = await start()
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS' }))
  addClient('c2', 'Unrelated work')

  server.down = false
  server.visitLimit = 0
  const done = await flush()
  log('everything else still saves', done === true && server.clients.some(c => c.id === 'c2'))
  log('the status is not stuck', saveStatus() === 'saved', saveStatus())
  log('the refused visit is not on the database', !server.visits.has(visit.id))
  log('it is marked Not saved, with the reason',
    heldVisits()[visit.id]?.reason === 'upgrade' && /inspection/.test(heldVisits()[visit.id].message))
  log('and says which client and site', heldVisits()[visit.id].clientName === 'Equinix' && heldVisits()[visit.id].locationId === 'l1')
  log('its answers are still on the device', localVisit(visit.id)?.rooms.r1?.results.main.t1 === 'PASS')

  const attempts = server.countCalls('startVisit')
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS', t2: 'PASS' }))
  addClient('c3', 'More work')
  await flush()
  log('more edits are kept but it is not sent on every save',
    server.countCalls('startVisit') === attempts && localVisit(visit.id).rooms.r1.results.main.t2 === 'PASS')
  log('and other work keeps going', server.clients.some(c => c.id === 'c3'))
  log('it counts as unsaved work', cache.hasUnsavedWork())

  await boot(server, device)
  log('it survives a reload, still marked', heldVisits()[visit.id]?.reason === 'upgrade' && localVisit(visit.id)?.rooms.r1?.results.main.t2 === 'PASS')
  log('it was tried once more on the way in', server.countCalls('startVisit') === attempts + 1)

  server.visitLimit = null
  await store.retryHeldVisit(visit.id)
  log('once the team upgrades it saves', server.visits.get(visit.id)?.rooms.r1?.results.main.t2 === 'PASS')
  log('and is no longer marked', !heldVisits()[visit.id] && !cache.hasUnsavedWork())
  log('counted once, as a refusal uses nothing', server.counted === 1, `${server.counted}`)
}
{
  const server = setup()
  server.visitLimit = 0
  await boot(server)
  server.down = true
  const { visit } = await start()
  server.down = false
  await flush()
  store.discardHeldVisit('c1', 'l1', visit.id)
  log('a refused visit can be discarded', !localVisit(visit.id) && !heldVisits()[visit.id])
  await flush()
  log('without any request to delete what the database never had', server.countCalls('deleteVisit') === 0)
}

// ── Dates the database refuses ──────────────────────────────────────────────
{
  const server = setup()
  await boot(server)
  server.down = true
  const { visit } = await start()
  writeClients(
    readClients().map(c => ({
      ...c,
      locations: c.locations.map(l => ({
        ...l,
        visits: (l.visits ?? []).map(v =>
          v.id === visit.id ? { ...v, startedAt: new Date(Date.now() - 8 * 86400000).toISOString() } : v,
        ),
      })),
    })),
  )
  addClient('c2', 'Other work')
  server.down = false
  await flush()
  log('a visit more than 7 days old goes to Not saved, with the reason',
    heldVisits()[visit.id]?.reason === 'date' && /7 days/.test(heldVisits()[visit.id].message))
  log('its date is not changed', Date.parse(localVisit(visit.id).startedAt) < Date.now() - 7 * 86400000)
  log('and it does not stop other work', server.clients.some(c => c.id === 'c2') && saveStatus() === 'saved')
}

// ── Two devices on one visit ────────────────────────────────────────────────
{
  const server = setup()
  await boot(server)
  server.down = true
  const { visit } = await start()
  saveRoom(visit.id, 'r1', answers({ t2: 'FAIL' }, { troubleshooting: { t2: 'Mine' } }))
  saveRoom(visit.id, 'r2', answers({ t1: 'PASS' }))

  // Meanwhile the other device started the same visit and got there first.
  server.down = false
  server.seedVisit({
    id: 'theirs',
    rooms: { r1: answers({ t1: 'PASS', t3: 'NA' }, { comments: 'Theirs' }) },
  })
  server.visitLimit = 1 // the allowance is used up: joining still isn't refused
  await flush()

  log('the second device joins the open visit', localVisit('theirs') && !localVisit(visit.id) && [...server.visits.keys()].join() === 'theirs',
    [...server.visits.keys()].join())
  const r1 = server.visits.get('theirs').rooms.r1
  log('both devices\' answers end up in the room, test by test',
    same(Object.entries(r1.results.main).sort(), [['t1', 'PASS'], ['t2', 'FAIL'], ['t3', 'NA']]), JSON.stringify(r1.results))
  log('notes and comments come too', r1.troubleshooting.t2 === 'Mine' && r1.comments === 'Theirs')
  log('rooms only this device did reach the database', server.visits.get('theirs').rooms.r2?.results.main.t1 === 'PASS')
  log('the visit was counted once, even with the allowance used up', server.counted === 1, `${server.counted}`)
  log('no refusal and nothing left over', saveStatus() === 'saved' && !cache.hasUnsavedWork() && !Object.keys(heldVisits()).length)

  // A room left open on the old id carries on saving.
  const entry = saveRoom(visit.id, 'r2', answers({ t1: 'PASS', t2: 'PASS' }))
  log('a page still holding the old id keeps saving', !!entry && localVisit('theirs').rooms.r2.results.main.t2 === 'PASS')
  log('and its open room is told to read again', cache.outsideChanges() > 0)
  await flush()
  log('to the visit it joined', server.visits.get('theirs').rooms.r2.results.main.t2 === 'PASS')
}
{
  // Both answered the same test: the newest wins.
  const server = setup()
  await boot(server)
  server.down = true
  const { visit } = await start()
  saveRoom(visit.id, 'r1', {
    ...answers({ t1: 'FAIL' }),
    touchedAt: new Date(Date.now() - 60000).toISOString(),
  })
  // saveRoomEntry stamps touchedAt, so set it back by hand to be the older edit.
  const clients = readClients()
  clients[0].locations[0].visits[0].rooms.r1.touchedAt = new Date(Date.now() - 60000).toISOString()
  writeClients(clients)
  server.down = false
  server.seedVisit({ id: 'theirs', rooms: { r1: answers({ t1: 'PASS' }) } })
  await flush()
  log('on the same test the newest edit wins', server.visits.get('theirs').rooms.r1.results.main.t1 === 'PASS')
}
{
  // A visit finished offline is its own inspection, not part of the open one.
  const server = setup()
  await boot(server)
  server.down = true
  const { visit } = await start()
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS' }))
  store.completeVisit('c1', 'l1', visit.id)
  server.down = false
  server.seedVisit({ id: 'theirs' })
  await flush()
  log('a visit finished offline saves as its own, beside the open one',
    server.visits.get(visit.id)?.completedAt && !server.visits.get('theirs').completedAt && server.counted === 2,
    `counted=${server.counted}`)
}
{
  // The other device opened a correction to an earlier visit. Joining it would
  // file this inspection under last year's.
  const server = setup()
  await boot(server)
  server.down = true
  const { visit } = await start()
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS' }))
  server.down = false
  server.seedVisit({ id: 'old', firstCompletedAt: new Date(Date.now() - 86400000 * 300).toISOString() })
  await flush()
  log('a correction open elsewhere is not joined', server.visits.size === 1 && heldVisits()[visit.id]?.reason === 'correction')
  log('it says to finish that first', /correction/i.test(heldVisits()[visit.id].message), heldVisits()[visit.id].message)
  log('the entered work stays on the device', localVisit(visit.id)?.rooms.r1?.results.main.t1 === 'PASS')
  log('the correction appears here so it can be finished', !!localVisit('old'))
  log('and is the visit the page works on',
    store.currentVisit(store.listVisits('c1', 'l1', 'maintenance')).id === 'old')

  store.completeVisit('c1', 'l1', 'old')
  await flush()
  log('the first completion date stands', server.visits.get('old').completedAt === server.visits.get('old').firstCompletedAt)
  await store.retryHeldVisit(visit.id)
  log('with it finished, the new visit saves', server.visits.get(visit.id)?.rooms.r1?.results.main.t1 === 'PASS' && !heldVisits()[visit.id])
}
{
  // The correction is a visit this device already holds, as it last saw it: finished.
  // It has been reopened on another device since. Found against the real database
  // by tests/offline-e2e.mjs: this device used to finish it again on its next save.
  const server = setup()
  const finished = new Date(Date.now() - 86400000).toISOString()
  server.seedVisit({ id: 'old', completedAt: finished, firstCompletedAt: finished, rooms: { r2: answers({ t3: 'FAIL' }) } })
  await boot(server)
  log('this device holds it as finished', !!localVisit('old')?.completedAt)

  server.visits.get('old').completedAt = null // reopened elsewhere
  server.visits.get('old').rooms.r2 = server.roomRow('old', 'r2', answers({ t3: 'PASS' })) // and corrected
  server.down = true
  const { visit } = await start()
  server.down = false
  await flush()
  await flush()

  const copies = data => data.flatMap(c => c.locations).flatMap(l => l.visits ?? []).filter(v => v.id === 'old')
  log('it is still not joined', heldVisits()[visit.id]?.reason === 'correction')
  log('this device doesn\'t finish it again', server.visits.get('old').completedAt === null, server.visits.get('old').completedAt)
  log('it shows here as open, as the database has it', localVisit('old')?.completedAt === null)
  log('with the other device\'s correction in it', localVisit('old')?.rooms.r2?.results.main.t3 === 'PASS')
  log('and nothing of this device\'s older copy sent back', server.visits.get('old').rooms.r2.results.main.t3 === 'PASS')
  log('one copy of it on the device', copies(readClients()).length === 1, `${copies(readClients()).length}`)
  log('and one in its record of what the database holds', copies(cache.readSaved()).length === 1, `${copies(cache.readSaved()).length}`)
}
{
  // Starting online and finding a correction open: it opens instead.
  const server = setup()
  await boot(server)
  server.seedVisit({ id: 'old', firstCompletedAt: new Date(Date.now() - 86400000 * 300).toISOString() })
  const started = await start()
  log('online, the correction is what comes back', started.outcome === 'correction' && started.visit.id === 'old')
  log('nothing is counted or left to send', server.counted === 1 && !cache.hasUnsavedWork())
}
{
  const server = setup()
  await boot(server)
  server.seedVisit({ id: 'theirs', rooms: { r1: answers({ t1: 'PASS' }) } })
  const started = await start()
  log('online, an open visit from another device is joined', started.outcome === 'joined' && localVisit('theirs')?.rooms.r1?.results.main.t1 === 'PASS')
  log('and nothing is left to send', !cache.hasUnsavedWork())
}

// ── Reconnecting with edits to a room someone else changed ──────────────────
{
  const server = setup()
  server.seedVisit({
    id: 'v1',
    rooms: { r1: answers({ t1: 'PASS' }, { comments: 'First', sections: { s1: true } }) },
  })
  await boot(server)
  const seen = cache.outsideChanges()

  // The other device answers another test, and adds a comment.
  server.visits.get('v1').rooms.r1 = server.roomRow('v1', 'r1',
    answers({ t1: 'PASS', t2: 'FAIL' }, { comments: 'First, and theirs', sections: { s1: true } }))

  await new Promise(r => setTimeout(r, 30)) // so this edit is the newer of the two
  saveRoom('v1', 'r1', answers({ t1: 'PASS', t3: 'PASS' }, { comments: 'First, and mine', sections: { s1: true } }))
  await flush()
  const row = server.visits.get('v1').rooms.r1
  log('a save merges with what another device did, rather than wiping it',
    same(Object.keys(row.results.main).sort(), ['t1', 't2', 't3']), JSON.stringify(row.results))
  log('both comments are kept, newest first', row.comments === 'First, and mine\n\nFirst, and theirs', JSON.stringify(row.comments))
  log('this device sees the merged room', localVisit('v1').rooms.r1.results.main.t2 === 'FAIL')
  log('and an open room is told to read it again', cache.outsideChanges() === seen + 1)
  const writes = server.countCalls('saveVisitRoom')
  await flush()
  log('it settles: nothing more to send', server.countCalls('saveVisitRoom') === writes && !cache.hasUnsavedWork())

  // No one else has touched it: no merge.
  saveRoom('v1', 'r1', { results: { main: { t1: 'PASS', t2: 'FAIL', t3: 'FAIL' } } })
  const quiet = cache.outsideChanges()
  await flush()
  log('with no other device involved, it is a plain save', cache.outsideChanges() === quiet && server.visits.get('v1').rooms.r1.results.main.t3 === 'FAIL')
}
{
  // Cleared here, unchanged there: stays cleared.
  const server = setup()
  server.seedVisit({ id: 'v1', rooms: { r1: answers({ t1: 'PASS', t2: 'PASS' }) } })
  await boot(server)
  server.visits.get('v1').rooms.r1 = server.roomRow('v1', 'r1', answers({ t1: 'PASS', t2: 'PASS', t3: 'NA' }))
  saveRoom('v1', 'r1', answers({ t1: 'PASS' }))
  await flush()
  const main = server.visits.get('v1').rooms.r1.results.main
  log('an answer cleared on this device stays cleared', !('t2' in main) && main.t3 === 'NA', JSON.stringify(main))
}

// ── Things deleted on another device ────────────────────────────────────────
{
  const server = setup()
  server.seedVisit({ id: 'v1' })
  const device = await boot(server)
  saveRoom('v1', 'r1', answers({ t1: 'PASS' }))
  addClient('c2', 'Other work')
  server.visits.delete('v1')
  await flush()
  log('a visit deleted elsewhere goes to Not saved', heldVisits().v1?.reason === 'gone', heldVisits().v1?.reason)
  log('other work carries on', server.clients.some(c => c.id === 'c2') && saveStatus() === 'saved')
  log('its answers are still on the device', localVisit('v1')?.rooms.r1?.results.main.t1 === 'PASS')

  await boot(server, device)
  log('after a reload it is still there to deal with', localVisit('v1')?.rooms.r1?.results.main.t1 === 'PASS' && heldVisits().v1?.reason === 'gone')
}
{
  // The whole site went.
  const server = setup()
  await boot(server)
  server.down = true
  const { visit } = await start()
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS' }))
  server.down = false
  server.removeLocation('l1')
  await flush()
  log('a visit whose site has been deleted goes to Not saved', heldVisits()[visit.id]?.reason === 'gone')
}
{
  const copies = new Map()
  const server = setup()
  const device = memoryDevice(copies)
  await boot(server, device)
  server.down = true
  const { visit } = await start()
  saveRoom(visit.id, 'r1', answers({ t1: 'PASS' }))
  server.down = false
  server.removeLocation('l1')
  await boot(server, device)
  const record = heldVisits()[visit.id]
  log('after a reload it has nowhere to go, but is not lost',
    record?.orphan === true && record.visit?.rooms.r1?.results.main.t1 === 'PASS', JSON.stringify(record?.reason))
  log('it can still be seen', record.clientName === 'Equinix')
  store.discardHeldVisit('c1', 'l1', visit.id)
  log('and discarded', !heldVisits()[visit.id])
}
{
  // Only the room went: the visit's other rooms still save.
  const server = setup()
  server.seedVisit({ id: 'v1' })
  await boot(server)
  saveRoom('v1', 'r1', answers({ t1: 'PASS' }))
  saveRoom('v1', 'r2', answers({ t2: 'PASS' }))
  server.removeRoom('r1')
  const done = await flush()
  const visit = server.visits.get('v1')
  log('a room deleted elsewhere keeps its answers, against no room',
    done === true && visit.roomless?.[0]?.results.main.t1 === 'PASS', JSON.stringify(visit.roomless?.[0]?.results))
  log('with its name copied beside them', visit.roomless?.[0]?.roomName !== undefined)
  log('and the other room saves', visit.rooms.r2?.results.main.t2 === 'PASS')
  log('with nothing left failing', saveStatus() === 'saved', saveStatus())
}

// ── Another tab's unsent work ───────────────────────────────────────────────
{
  const copies = new Map()
  const server = setup()
  const tabTwo = memoryDevice(copies, 'tab-2')
  await boot(server, tabTwo)
  server.down = true
  addClient('c2', 'From the other tab')
  await flush()

  // A different tab opens, with the connection back.
  server.down = false
  const tabOne = memoryDevice(copies, 'tab-1')
  copies.set('user:team:tab-3', { ...structuredClone(copies.get(tabTwo.ownId)), id: 'user:team:tab-3', savedAt: 0 })
  addClient('c4', 'Never saved in tab 2')
  await boot(server, tabOne)
  log('a new tab picks up the newest copy', server.clients.some(c => c.id === 'c2'), server.clients.map(c => c.id).join())
  log('and leaves no copy behind but its own', [...copies.keys()].join() === tabOne.ownId, [...copies.keys()].join())
}
{
  const copies = new Map()
  const server = setup()
  const tabOne = memoryDevice(copies, 'tab-1')
  await boot(server, tabOne)
  server.down = true
  addClient('c2', 'From this tab')
  const tabTwo = memoryDevice(copies, 'tab-2')
  const clients = readClients()
  // Tab 2's copy holds different unsent work, saved earlier.
  copies.set(tabTwo.ownId, {
    id: tabTwo.ownId,
    data: { clients: [...clients.filter(c => c.id !== 'c2'), { id: 'c3', name: 'From the other tab', locations: [] }], settings: null, templates: {} },
    snapshot: { clients: clients.filter(c => c.id !== 'c2'), settings: null, templates: {} },
    held: {},
    unsaved: true,
    savedAt: 0,
  })

  await boot(server, tabOne)
  log('with no connection, each tab\'s copy stays put', copies.has(tabTwo.ownId) && saveStatus() === 'offline')
  server.down = false
  await flush()
  log('when it returns, both tabs\' work reaches the database',
    server.clients.some(c => c.id === 'c2') && server.clients.some(c => c.id === 'c3'), server.clients.map(c => c.id).join())
  log('and the other tab\'s copy goes', !copies.has(tabTwo.ownId))
}

// ── A visit continued the next day ──────────────────────────────────────────
{
  const server = setup()
  server.seedVisit({
    id: 'v1',
    startedAt: new Date(Date.now() - 86400000).toISOString(),
    rooms: { r1: answers({ t1: 'PASS' }, { status: 'complete' }) },
  })
  const counted = server.counted
  await boot(server)
  log('the next day it is still open', store.openVisit('c1', 'l1', 'maintenance')?.id === 'v1')
  saveRoom('v1', 'r2', answers({ t1: 'FAIL' }))
  store.completeVisit('c1', 'l1', 'v1')
  await flush()
  log('finishing it saves today\'s work beside yesterday\'s',
    server.visits.get('v1').rooms.r1.results.main.t1 === 'PASS' && server.visits.get('v1').rooms.r2.results.main.t1 === 'FAIL' && !!server.visits.get('v1').completedAt)
  log('and it is not counted again', server.counted === counted)
}

// ── Report records ──────────────────────────────────────────────────────────
{
  const server = setup()
  const device = await boot(server)
  const { visit } = await start()
  store.recordExport('c1', 'l1', visit.id, { mode: 'revision', filename: 'Rev 1.xlsx' })
  store.recordExport('c1', 'l1', visit.id, { mode: 'revision', filename: 'Rev 2.xlsx' })
  await flush()
  const revisions = () => server.visits.get(visit.id).exports.map(e => e.revision).join()
  log('report records reach the database', revisions() === '1,2', revisions())

  store.deleteExport('c1', 'l1', visit.id, 2)
  await flush()
  log('deleting one deletes it on the database', revisions() === '1', revisions())
  log('and leaves nothing to send', !cache.hasUnsavedWork() && saveStatus() === 'saved')

  await boot(server, device)
  log('it stays deleted after a reload', localVisit(visit.id).exports.map(e => e.revision).join() === '1')

  store.recordExport('c1', 'l1', visit.id, { mode: 'revision', filename: 'Rev 2 again.xlsx' })
  await flush()
  const reused = server.visits.get(visit.id).exports.find(e => e.revision === 2)
  log('the next report reuses the number', reused?.filename === 'Rev 2 again.xlsx', JSON.stringify(reused))

  // Deleted and made again in one save: the new record is the one that's left.
  store.deleteExport('c1', 'l1', visit.id, 2)
  store.recordExport('c1', 'l1', visit.id, { mode: 'revision', filename: 'Rev 2 third.xlsx' })
  await flush()
  log('deleted and made again in one save, the new one stands',
    server.visits.get(visit.id).exports.find(e => e.revision === 2)?.filename === 'Rev 2 third.xlsx')

  // With no connection.
  server.down = true
  store.deleteExport('c1', 'l1', visit.id, 2)
  await flush()
  log('deleted with no connection, it waits', revisions() === '1,2' && saveStatus() === 'offline')
  await boot(server, device)
  log('through a reload', localVisit(visit.id).exports.map(e => e.revision).join() === '1')
  server.down = false
  await flush()
  log('and goes when the connection returns', revisions() === '1', revisions())

  // The answer lost on the way back: sent again, with nothing left to delete.
  store.recordExport('c1', 'l1', visit.id, { mode: 'revision', filename: 'Rev 2.xlsx' })
  await flush()
  store.deleteExport('c1', 'l1', visit.id, 2)
  server.loseAnswer('deleteExport')
  const first = await flush()
  const second = await flush()
  log('a delete whose answer is lost can safely be sent again', first === false && second === true && revisions() === '1', revisions())

  // Another device, which hasn't heard, doesn't bring it back.
  const stale = setup()
  stale.seedVisit({ id: 'v1', exports: [{ id: 'x1', revision: 1, filename: 'Rev 1.xlsx' }, { id: 'x2', revision: 2, filename: 'Rev 2.xlsx' }] })
  await boot(stale)
  stale.visits.get('v1').exports = stale.visits.get('v1').exports.filter(e => e.revision !== 2) // deleted elsewhere
  saveRoom('v1', 'r1', answers({ t1: 'PASS' }))
  await flush()
  log('another device\'s unrelated save doesn\'t bring a deleted record back',
    stale.visits.get('v1').exports.map(e => e.revision).join() === '1')

  // A visit somehow holding no list says nothing about its records.
  const missing = setup()
  missing.seedVisit({ id: 'v1', exports: [{ id: 'x1', revision: 1, filename: 'Rev 1.xlsx' }] })
  await boot(missing)
  const clients = readClients()
  delete clients[0].locations[0].visits[0].exports
  writeClients(clients)
  await flush()
  log('a visit with no list of records doesn\'t delete them all', missing.visits.get('v1').exports.length === 1)
}

// ── Readings, the whole-site step and room types (C1) ───────────────────────
// A site list: one test for the whole site and two repeated for each alarm.
const SITE_LIST = {
  mainLabel: 'Main test list',
  tests: [],
  sections: [
    { id: 'ss', label: 'Whole property', scope: 'site', tests: [{ id: 'w1', label: 'Alarm on each level' }] },
    {
      id: 'si', label: 'Each smoke alarm', scope: 'item', assetType: 'smoke_alarm',
      tests: [{ id: 'k1', label: 'Works when tested' }, { id: 'k2', label: 'Cleaned' }],
    },
  ],
}
const siteAnswers = (results, extra = {}) => ({ template: SITE_LIST, results, sections: {}, troubleshooting: {}, comments: '', ...extra })
const saveSite = (visitId, patch) => store.saveSiteEntry('c1', 'l1', visitId, patch)
{
  const server = setup()
  server.seedVisit({ id: 'v1' })
  const device = await boot(server)
  const updates = server.countCalls('updateVisit')
  saveRoom('v1', 'r1', answers({ t1: 'PASS' }, { readings: { main: { t1: { value: '0.4', unit: 'Ω' } } } }))
  await flush()
  log('a room\'s readings reach the database', server.visits.get('v1').rooms.r1.readings?.main?.t1?.value === '0.4')
  log('saving only a room doesn\'t write the visit', server.countCalls('updateVisit') === updates)

  saveSite('v1', siteAnswers({ ss: { w1: 'PASS' }, si: { a1: { k1: 'FAIL' } } }, { readings: { si: { a1: { k2: { value: '3', unit: 's' } } } } }))
  await flush()
  const site = server.visits.get('v1').siteResults
  log('the whole-site step reaches the database',
    site.results?.ss?.w1 === 'PASS' && site.results?.si?.a1?.k1 === 'FAIL' && site.readings?.si?.a1?.k2?.value === '3', JSON.stringify(site.results))
  log('with its test list', site.template?.sections?.length === 2)
  const writes = server.countCalls('updateVisit')
  await flush()
  log('and settles: nothing more to send', server.countCalls('updateVisit') === writes && !cache.hasUnsavedWork())

  await boot(server, device)
  log('both come back after a reload',
    localVisit('v1').rooms.r1.readings?.main?.t1?.unit === 'Ω' && store.getSiteEntry('c1', 'l1', 'v1')?.results?.si?.a1?.k1 === 'FAIL')

  server.down = true
  saveSite('v1', siteAnswers({ ss: { w1: 'NA' }, si: { a1: { k1: 'FAIL' } } }))
  await flush()
  await boot(server, device)
  log('a whole-site answer made offline survives a reload', store.getSiteEntry('c1', 'l1', 'v1')?.results?.ss?.w1 === 'NA')
  server.down = false
  await flush()
  log('and goes when the connection returns', server.visits.get('v1').siteResults.results.ss.w1 === 'NA')
}
{
  // Another device changed the whole-site step since this one last read it.
  const server = setup()
  server.seedVisit({ id: 'v1', siteResults: siteAnswers({ si: { a1: { k1: 'PASS' } } }, { touchedAt: new Date(Date.now() - 60000).toISOString() }) })
  await boot(server)
  const seen = cache.outsideChanges()
  server.visits.get('v1').siteResults = siteAnswers(
    { si: { a1: { k1: 'PASS', k2: 'FAIL' }, a2: { k1: 'PASS' } } },
    { troubleshooting: { 'a1:k2': 'Dusty' }, comments: 'Theirs', touchedAt: new Date(Date.now() - 30000).toISOString() },
  )
  saveSite('v1', siteAnswers({ ss: { w1: 'PASS' }, si: { a1: { k1: 'PASS' }, a3: { k1: 'FAIL' } } }, { comments: 'Mine' }))
  await flush()
  const site = server.visits.get('v1').siteResults
  log('a whole-site save merges with another device\'s, item by item',
    site.results.ss?.w1 === 'PASS' && site.results.si.a1.k2 === 'FAIL' && site.results.si.a2?.k1 === 'PASS' && site.results.si.a3?.k1 === 'FAIL',
    JSON.stringify(site.results))
  log('notes and comments come too', site.troubleshooting['a1:k2'] === 'Dusty' && site.comments === 'Mine\n\nTheirs', JSON.stringify(site.comments))
  log('the merged step has no status or fail count of its own', !('fails' in site) && !('status' in site))
  log('this device sees it merged', store.getSiteEntry('c1', 'l1', 'v1').results.si.a2?.k1 === 'PASS')
  log('and an open page is told to read it again', cache.outsideChanges() === seen + 1)
  const writes = server.countCalls('updateVisit')
  await flush()
  log('it settles', server.countCalls('updateVisit') === writes && !cache.hasUnsavedWork())

  // The same alarm's same test on both: the newest wins.
  server.visits.get('v1').siteResults = {
    ...site,
    results: { ...site.results, si: { ...site.results.si, a3: { k1: 'PASS' } } },
    touchedAt: new Date(Date.now() - 1000).toISOString(),
  }
  await new Promise(r => setTimeout(r, 5))
  saveSite('v1', { results: { ...site.results, si: { ...site.results.si, a3: { k1: 'NA' } } } })
  await flush()
  log('on the same item and test, the newest edit wins', server.visits.get('v1').siteResults.results.si.a3.k1 === 'NA')
}
{
  // Joining a visit another device started brings both whole-site steps together.
  const server = setup()
  await boot(server)
  server.down = true
  const { visit } = await start()
  saveSite(visit.id, siteAnswers({ si: { a1: { k1: 'FAIL' } } }))
  server.down = false
  server.seedVisit({ id: 'theirs', siteResults: siteAnswers({ ss: { w1: 'PASS' } }, { touchedAt: new Date(Date.now() - 60000).toISOString() }) })
  await flush()
  const site = server.visits.get('theirs').siteResults
  log('joining an open visit keeps both devices\' whole-site answers',
    site.results.ss?.w1 === 'PASS' && site.results.si?.a1?.k1 === 'FAIL', JSON.stringify(site.results))
}
{
  // A room's type is saved with it.
  const server = setup()
  const device = await boot(server)
  const clients = readClients()
  clients[0].locations[0].floors[0].rooms.push({ id: 'r3', name: 'Bedroom 1', planNumber: '', roomType: 'bedroom' })
  clients[0].locations[0].floors[0].rooms[0].roomType = 'hallway'
  writeClients(clients)
  await flush()
  const rooms = server.clients[0].locations[0].floors[0].rooms
  log('a new room goes in with its type', rooms.find(r => r.id === 'r3')?.roomType === 'bedroom')
  log('a changed type is saved', rooms.find(r => r.id === 'r1')?.roomType === 'hallway')
  await boot(server, device)
  log('and both come back', readClients()[0].locations[0].floors[0].rooms.find(r => r.id === 'r3')?.roomType === 'bedroom')
}
{
  // A correction finished again keeps the date it was first finished.
  const server = setup()
  const first = new Date(Date.now() - 86400000 * 300).toISOString()
  server.seedVisit({ id: 'old', completedAt: null, firstCompletedAt: first })
  await boot(server)
  store.completeVisit('c1', 'l1', 'old')
  log('finishing a correction shows its first date straight away', localVisit('old').completedAt === first, localVisit('old').completedAt)
  await flush()
  log('which is the date the database kept', server.visits.get('old').completedAt === first && localVisit('old').completedAt === first)

  // A device that didn't know it had one finds out from the database.
  server.visits.get('old').completedAt = null // reopened elsewhere
  const device = await boot(server)
  const clients = readClients()
  delete clients[0].locations[0].visits.find(v => v.id === 'old').firstCompletedAt
  writeClients(clients)
  store.completeVisit('c1', 'l1', 'old')
  log('without it, this device would show today', localVisit('old').completedAt !== first)
  await flush()
  log('after saving it shows the date the database kept', localVisit('old').completedAt === first, localVisit('old').completedAt)
  log('in its record of the database too', cache.readSaved()[0].locations[0].visits.find(v => v.id === 'old').completedAt === first)
  const writes = server.countCalls('updateVisit')
  await flush()
  log('and nothing more to send', server.countCalls('updateVisit') === writes && !cache.hasUnsavedWork())
  await boot(server, device)
  log('through a reload', localVisit('old').completedAt === first)

  // A first finish is today, as it always was.
  const fresh = setup()
  fresh.seedVisit({ id: 'new' })
  await boot(fresh)
  store.completeVisit('c1', 'l1', 'new')
  await flush()
  const done = Date.parse(localVisit('new').completedAt)
  log('a visit finished for the first time takes today\'s date',
    Date.now() - done < 60000 && fresh.visits.get('new').completedAt === localVisit('new').completedAt)
  store.reopenVisit('c1', 'l1', 'new')
  await new Promise(r => setTimeout(r, 5))
  store.recordExport('c1', 'l1', 'new', { mode: 'revision', filename: 'Rev 1.xlsx' })
  log('reopened and finished by exporting, it keeps that date', Date.parse(localVisit('new').completedAt) === done)
}

// ── The import still gets all or nothing ────────────────────────────────────
{
  const server = new FakeServer()
  const adapter = supabaseAdapter(TEAM, USER, server.api)
  const empty = { clients: [], settings: null, templates: {} }
  const visit = {
    id: 'v1', kind: 'maintenance', technician: '', startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(), rooms: {}, exports: [],
  }
  const client = {
    id: 'c1', name: 'Imported',
    locations: [{ id: 'l1', address: '1 High St', suburb: 'Town', floors: [], visits: [visit] }],
  }
  await adapter.persist({ ...empty, clients: [client] }, empty)
  log('an import still saves through persist', server.visits.get('v1')?.completedAt === visit.completedAt)

  let reason = ''
  try {
    await adapter.persist({ ...empty, clients: [{ ...client, id: 'c2' }] }, empty)
  } catch (e) {
    reason = e.message
  }
  log('and throws rather than setting aside what it cannot save', /already exists/.test(reason), reason)
}

// ── The merge, on its own ───────────────────────────────────────────────────
{
  const older = { touchedAt: '2026-10-01T00:00:00Z' }
  const newer = { touchedAt: '2026-10-02T00:00:00Z' }
  const room = (main, extra = {}) => ({ template: TEMPLATE, results: { main }, sections: {}, troubleshooting: {}, comments: '', ...extra })

  log('deepEqual ignores the order jsonb puts keys in', deepEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }) && !deepEqual({ a: 1 }, { a: 2 }))
  log('with no base, everything from both sides stays',
    same(mergeRoom(undefined, room({ t1: 'PASS' }, newer), room({ t2: 'FAIL' }, older)).results.main, { t1: 'PASS', t2: 'FAIL' }))
  log('with a base, a side that did not change something does not bring it back',
    same(mergeRoom(room({ t1: 'PASS', t2: 'PASS' }), room({ t1: 'PASS' }, newer), room({ t1: 'PASS', t2: 'PASS' }, older)).results.main, { t1: 'PASS' }))
  log('the newest wins on the same test, in either direction',
    mergeRoom(undefined, room({ t1: 'PASS' }, newer), room({ t1: 'FAIL' }, older)).results.main.t1 === 'PASS' &&
    mergeRoom(undefined, room({ t1: 'PASS' }, older), room({ t1: 'FAIL' }, newer)).results.main.t1 === 'FAIL')
  log('fails are counted on what came out',
    mergeRoom(undefined, room({ t1: 'FAIL' }, newer), room({ t2: 'FAIL' }, older)).fails === 2)
  log('two different notes on one test are both kept',
    mergeRoom(undefined, room({}, { ...newer, troubleshooting: { t1: 'Mine' } }), room({}, { ...older, troubleshooting: { t1: 'Theirs' } })).troubleshooting.t1 === 'Mine\n\nTheirs')
  log('a note that already holds the other is not doubled',
    mergeRoom(undefined, room({}, { ...newer, comments: 'Mine and theirs' }), room({}, { ...older, comments: 'theirs' })).comments === 'Mine and theirs')
  log('a cleared comment stays cleared if the other side did not change it',
    mergeRoom(room({}, { comments: 'Old' }), room({}, { ...newer, comments: '' }), room({}, { ...older, comments: 'Old' })).comments === '')

  const otherList = { mainLabel: 'x', tests: [{ id: 'z1', label: 'Other' }, { id: 'z2', label: 'Unanswered' }], sections: [{ id: 's9', label: 'Extra', tests: [{ id: 'z3', label: 'In a section' }] }] }
  const joined = mergeRoom(undefined, { ...room({ z1: 'PASS' }, newer), template: otherList, results: { main: { z1: 'PASS' }, s9: { z3: 'FAIL' } } }, room({ t1: 'PASS' }, older))
  log('answers to a test only the other list has are not left unshowable',
    joined.template.tests.some(t => t.id === 'z1') && !joined.template.tests.some(t => t.id === 'z2') && joined.template.sections[0]?.tests[0]?.id === 'z3',
    JSON.stringify(joined.template.tests.map(t => t.id)))

  // Two devices that each filled an empty list: same tests, different ids.
  const listA = { mainLabel: 'x', tests: [{ id: 'a1', label: 'Video' }, { id: 'a2', label: 'Audio' }], sections: [{ id: 'as', label: 'Room controls', tests: [{ id: 'a3', label: 'Mute' }] }] }
  const listB = { mainLabel: 'x', tests: [{ id: 'b1', label: 'Video' }, { id: 'b2', label: 'Audio' }], sections: [{ id: 'bs', label: 'Room controls', tests: [{ id: 'b3', label: 'Mute' }] }] }
  const twoLists = mergeRoom(
    undefined,
    { template: listB, results: { main: { b1: 'FAIL' }, bs: { b3: 'PASS' } }, sections: { bs: true }, troubleshooting: { b1: 'Mine' }, comments: '', ...newer },
    { template: listA, results: { main: { a2: 'PASS' } }, sections: {}, troubleshooting: {}, comments: '', ...older },
  )
  log('the same label in the same section is the same test, not two',
    twoLists.template.tests.length === 2 && twoLists.template.sections.length === 1 && twoLists.template.sections[0].tests.length === 1,
    JSON.stringify(twoLists.template.tests.map(t => t.id)))
  log('and the answers line up under the list that is kept',
    same(twoLists.results.main, { a1: 'FAIL', a2: 'PASS' }) && twoLists.results.as?.a3 === 'PASS' && twoLists.sections.as === true && twoLists.troubleshooting.a1 === 'Mine',
    JSON.stringify(twoLists.results))
  log('so the failed one is counted', twoLists.fails === 1, `${twoLists.fails}`)

  const merged = mergeVisit(
    { id: 'mine', technician: 'Sam', completedAt: null, rooms: { r2: room({ t1: 'PASS' }) }, exports: [{ revision: 2 }], exportPreference: 'revision' },
    { id: 'theirs', technician: '', startedAt: 'then', completedAt: null, firstCompletedAt: null, rooms: { r1: room({ t2: 'PASS' }) }, exports: [{ revision: 1 }] },
  )
  log('a joined visit carries on under the server\'s id, with both sets of rooms',
    merged.id === 'theirs' && merged.startedAt === 'then' && same(Object.keys(merged.rooms).sort(), ['r1', 'r2']) && merged.exports.length === 2)
  log('a blank technician takes this device\'s', merged.technician === 'Sam')

  // The whole-site step, and sections repeated per item.
  const item = { mainLabel: 'x', tests: [], sections: [{ id: 'si', label: 'Each alarm', scope: 'item', assetType: 'smoke_alarm', tests: [{ id: 'k1', label: 'Works' }] }] }
  const itemB = { mainLabel: 'x', tests: [], sections: [{ id: 'sb', label: 'Each alarm', scope: 'item', assetType: 'smoke_alarm', tests: [{ id: 'kb', label: 'Works' }, { id: 'kc', label: 'Only here' }] }] }
  const site = mergeSite(
    undefined,
    { template: itemB, results: { sb: { a1: { kb: 'FAIL' }, a2: { kc: 'PASS' } } }, troubleshooting: { 'a1:kb': 'Mine' }, ...newer },
    { template: item, results: { si: { a1: { k1: 'PASS' }, a3: { k1: 'PASS' } } }, troubleshooting: {}, ...older },
  )
  log('a per-item test with another id lines up under the kept list, item by item',
    site.results.si.a1.k1 === 'FAIL' && site.results.si.a3.k1 === 'PASS' && site.troubleshooting['a1:k1'] === 'Mine', JSON.stringify(site))
  log('a test only the other list has, answered for just one item, joins the list',
    site.template.sections[0].tests.some(t => t.id === 'kc') && site.results.si.a2.kc === 'PASS', JSON.stringify(site.template.sections[0].tests))
  log('a whole-site step has no fail count or status', !('fails' in site) && !('status' in site))
  log('nothing on one side, the other is kept as it is',
    mergeSite(undefined, undefined, { results: { x: 1 } }).results.x === 1 && mergeSite(undefined, { results: { y: 1 } }, {}).results.y === 1)
  const joinedSite = mergeVisit(
    { id: 'mine', rooms: {}, siteResults: { template: item, results: { si: { a1: { k1: 'PASS' } } } } },
    { id: 'theirs', rooms: {}, siteResults: {} },
  )
  log('a joined visit keeps this device\'s whole-site answers', joinedSite.siteResults.results.si.a1.k1 === 'PASS')
  log('and has one even when neither side did', same(mergeVisit({ id: 'a', rooms: {} }, { id: 'b', rooms: {} }).siteResults, {}))
}

// ── Failures, as the real Supabase client reports them ──────────────────────
{
  const respond = (status, body, type = 'application/json') => async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } })

  const errorFrom = async fetch => {
    const client = createClient('http://localhost:9', 'key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch },
    })
    const { error } = await client.from('visits').insert({ id: 'x' }).select().single()
    return error
  }

  const cases = [
    ['a failed fetch', async () => { throw new TypeError('Failed to fetch') }, 'network'],
    ['a timed-out request', async () => { throw new DOMException('The operation timed out.', 'TimeoutError') }, 'network'],
    ['an aborted request', async () => { throw new DOMException('Aborted', 'AbortError') }, 'network'],
    ['a gateway\'s HTML error page', respond(502, '<html>Bad gateway</html>', 'text/html'), 'network'],
    ['PostgREST losing the database', respond(503, { code: 'PGRST001', message: 'Database client error', hint: null, details: null }), 'network'],
    ['an expired login token', respond(401, { code: 'PGRST303', message: 'JWT expired', hint: null, details: null }), 'network'],
    ['a plan refusal', respond(402, { code: 'PT402', message: 'This plan includes 1 inspection', hint: 'upgrade', details: null }), 'upgrade'],
    ['a date refusal', respond(400, { code: '23514', message: 'more than 7 days ago', hint: 'visit_date', details: null }), 'date'],
    ['a duplicate', respond(409, { code: '23505', message: 'duplicate key', hint: null, details: null }), 'conflict'],
    ['a missing parent row', respond(409, { code: '23503', message: 'foreign key', hint: null, details: null }), 'gone'],
    ['a permission refusal', respond(403, { code: '42501', message: 'permission denied', hint: null, details: null }), 'other'],
  ]
  for (const [name, fetch, expected] of cases) {
    const error = await errorFrom(fetch)
    log(`${name} is classed as ${expected}`, classifySaveError(error) === expected, `${classifySaveError(error)} ${JSON.stringify(error?.code)}`)
  }
  log('a bug in the code is not mistaken for a bad connection', classifySaveError(new TypeError('x is not a function')) === 'other')
  log('a deleted visit is classed as gone', classifySaveError(Object.assign(new Error('gone'), { code: 'VISIT_GONE' })) === 'gone')
  log('a connection error with its own code is still a connection error', classifySaveError({ code: 'ECONNRESET', message: 'reset' }) === 'network')
}

process.exit(0)
