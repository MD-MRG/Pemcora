// The service worker: what lets the app open with no signal (build plan, step B3b).
//
// vite.config.js turns this into dist/sw.js at build time, filling in the build's
// file list. Nothing imports it, and it only ever runs from a production build.
//
// It keeps the app's own files and nothing else. Same-origin GET requests only:
// the database, logins and file storage are other origins and go past untouched,
// so no data or token ever lands in its cache. The team's data lives in the device
// copy (src/lib/offlineStore.js), under the app's own control.
//
// The main page always comes from the network when there is one, so a deploy still
// reaches people. Files with a hash in their name never change, so those come from
// the cache. A new build arrives as a new worker with a new file list, installed
// whole before it takes over.
//
// If this ever needs turning off for everyone: deploy a sw.js that unregisters
// itself. Browsers check for a new one on every load, past any HTTP caching.

const BUILD = '__BUILD__'
const FILES = __FILES__
const CACHE = `pemcora-${BUILD}`

// A tab left open on the last build can still ask for a file that build loads late
// (the Excel library), so that build's cache stays until the one after.
const KEEP = 2

// How long to wait for the network on a poor connection before opening from the
// cache. Anything slower and a technician is staring at a blank page.
const PATIENCE = 4000

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // Past the HTTP cache: GitHub Pages lets index.html be cached for 10 minutes,
      // and an old page stored against this build's files would open blank.
      await cache.addAll(FILES.map(url => new Request(url, { cache: 'reload' })))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const ours = (await caches.keys()).filter(name => name.startsWith('pemcora-'))
      // Named pemcora-<time built>-<hash>, so they sort oldest first.
      const stale = ours.filter(name => name !== CACHE).sort().reverse().slice(KEEP - 1)
      await Promise.all(stale.map(name => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

async function openPage(request) {
  const network = fetch(request)
  const cached = async () => (await caches.open(CACHE)).match('index.html')

  const answer = await Promise.race([
    network.catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), PATIENCE)),
  ])
  if (answer) return answer

  // Not stored from the network on purpose: a page from a newer build, stored here,
  // would point at files this build never fetched.
  return (await cached()) ?? network
}

async function openFile(request) {
  // ignoreVary: the page asks for scripts with an Origin header and install didn't,
  // and a server sending Vary: Origin would make that a miss for the very same file.
  const cached = await caches.match(request, { ignoreVary: true })
  return cached ?? fetch(request)
}

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return
  event.respondWith(request.mode === 'navigate' ? openPage(request) : openFile(request))
})
