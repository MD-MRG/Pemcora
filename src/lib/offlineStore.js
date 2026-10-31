// The copy of a team's data kept on this device, in IndexedDB.
//
// What makes a dropped connection, a closed app or a reload lose nothing: every
// change lands here before anything is sent to the database (build plan 2.2).
// A copy holds the cache's data and the last version the database is known to
// hold, so what still has to be sent can be worked out again after a restart.
//
// One copy per tab, per person and team. Two tabs each hold their own edits in
// memory, and a single shared record would let the second overwrite the first's
// unsent work. The tab's id lives in sessionStorage, which survives a reload of
// that tab and nothing else.
//
// This is ordinary browser storage: anyone using this browser profile can read
// it. Signing out wipes it unless the person chooses to keep unsaved work
// (see AccountPanel).

const DB_NAME = 'pemcora-offline'
const STORE = 'copies'
const TAB_KEY = 'fc.tab'

let opening = null

function openDb() {
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => {
      const db = request.result
      // Another tab upgrading the schema must not be blocked by this handle.
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('The device copy is blocked by another tab'))
  })
  opening.catch(() => {
    opening = null
  })
  return opening
}

const asPromise = request =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

function tabId() {
  try {
    let id = sessionStorage.getItem(TAB_KEY)
    if (!id) {
      id = crypto.randomUUID()
      sessionStorage.setItem(TAB_KEY, id)
    }
    return id
  } catch {
    // Without sessionStorage a tab is new on every load, which only means its
    // copy is picked up as another tab's rather than its own.
    return crypto.randomUUID()
  }
}

async function allCopies() {
  const db = await openDb()
  return asPromise(db.transaction(STORE).objectStore(STORE).getAll())
}

async function removeCopies(ids) {
  if (!ids.length) return
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  for (const id of ids) tx.objectStore(STORE).delete(id)
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

const newestFirst = (a, b) => String(b.savedAt).localeCompare(String(a.savedAt))

/**
 * The copies for one person and team, as the cache uses them.
 *
 *   load()    { own, others }: this tab's copy (or the newest, on a new tab) and
 *             the rest, which may hold another tab's unsent work.
 *   save()    called on every change. Never throws: a full disk mustn't stop the
 *             app, it only means the copy falls behind.
 *   remove()  forgets a copy whose work has reached the database.
 */
export function deviceCopies(userId, teamId) {
  const tab = tabId()
  const ownId = `${userId}:${teamId}:${tab}`
  let db = null
  let warned = false

  const warn = e => {
    if (warned) return
    warned = true
    console.error('[offline] could not write the device copy', e)
  }

  return {
    async load() {
      db = await openDb()
      const mine = (await allCopies()).filter(c => c.userId === userId && c.teamId === teamId)
      const own = mine.find(c => c.id === ownId) ?? [...mine].sort(newestFirst)[0] ?? null
      const others = mine.filter(c => c !== own)
      return { own, others }
    },

    // Called synchronously on every change, so the transaction has already
    // started if the page goes away straight afterwards.
    save(copy) {
      if (!db) return
      try {
        const tx = db.transaction(STORE, 'readwrite')
        tx.onerror = () => warn(tx.error)
        tx.objectStore(STORE).put({
          ...copy,
          id: ownId,
          userId,
          teamId,
          savedAt: new Date().toISOString(),
        })
      } catch (e) {
        warn(e)
      }
    },

    remove: ids => removeCopies(ids),
    ownId,
  }
}

export const removeCopy = id => removeCopies([id])

/** What this device still holds for someone: copies with work not yet saved. */
export async function unsavedCopies(userId) {
  try {
    const copies = await allCopies()
    return copies.filter(c => c.userId === userId && (c.unsaved || Object.keys(c.held ?? {}).length))
  } catch {
    return []
  }
}

/** Wipes the device copies when someone signs out. `keepUnsaved` leaves those
 *  with work still to send, for the next time they sign in here. */
export async function clearCopies(userId, { keepUnsaved = false } = {}) {
  try {
    const copies = (await allCopies()).filter(c => c.userId === userId)
    const doomed = copies.filter(c => !keepUnsaved || !(c.unsaved || Object.keys(c.held ?? {}).length))
    await removeCopies(doomed.map(c => c.id))
  } catch (e) {
    console.error('[offline] could not clear the device copy', e)
  }
}
