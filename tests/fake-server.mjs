/**
 * A stand-in for the database, for testing the save queue.
 *
 * It answers the same calls as src/lib/api.js and keeps the rules that matter to
 * saving, the way 0001 and 0006 keep them: one open visit per site and check, a
 * client's name unique in its team, what a refused visit gets back, dates held to
 * the last 7 days, and a reopened visit keeping its first completion date.
 *
 * A row whose parent has gone gets 23503, as api.js reports it. The real database's
 * security rules say 42501 first, and api.js looks for the parent to tell the two apart.
 *
 * The rules themselves are proved against real Postgres in docs/editions/test/.
 * This is only here so the app can be tested against them, on bad days, without
 * writing to the live project. tests/offline-e2e.mjs is the real thing.
 *
 * What a real connection does, it can do on demand:
 *
 *   server.down = true        nothing gets through (a failed fetch)
 *   server.loseAnswer(name)   the next such call lands, then the answer is lost
 *   server.failNext(name, e)  the next such call fails with this error
 *   server.hold(name)         the next such call waits; call the result to go on
 */

const DAY = 86400000

const NETWORK = () => ({ code: '', message: 'TypeError: Failed to fetch', details: '', hint: '' })

const pg = (code, message, hint = null) => ({ code, message, hint, details: null })
const coded = (message, code) => Object.assign(new Error(message), { code })

const clone = v => (v === undefined ? undefined : structuredClone(v))

export class FakeServer {
  constructor() {
    this.clients = []
    this.visits = new Map()
    this.settings = { company: {}, logoFull: null, logoCollapsed: null, plate: 'brass' }
    this.templates = { maintenance: {}, commissioning: {}, custom: {} }
    this.prefs = { defaultTechnician: '' }

    this.down = false
    this.admin = true
    this.visitLimit = null // inspections left, when the plan limits are on
    this.counted = 0 // the monthly counter: goes up once per visit first saved
    this.packRefused = new Set() // visit kinds whose pack this team doesn't hold
    this.plan = {} // anything team_entitlements() should answer differently
    this.calls = []
    this.tick = 0

    this.lost = new Set()
    this.failures = new Map()
    this.holds = new Map()

    this.api = new Proxy(this.methods(), {
      get: (methods, name) => {
        const method = methods[name]
        if (!method) return undefined
        return async (...args) => {
          this.calls.push(name)
          if (this.down) throw NETWORK()
          if (this.holds.has(name)) {
            const wait = this.holds.get(name)
            this.holds.delete(name)
            await wait
            if (this.down) throw NETWORK()
          }
          if (this.failures.has(name)) {
            const e = this.failures.get(name)
            this.failures.delete(name)
            throw e
          }
          const answer = await method(...args)
          if (this.lost.has(name)) {
            this.lost.delete(name)
            throw NETWORK()
          }
          return clone(answer)
        }
      },
    })
  }

  loseAnswer(name) {
    this.lost.add(name)
  }

  failNext(name, error) {
    this.failures.set(name, error)
  }

  hold(name) {
    let release
    this.holds.set(name, new Promise(resolve => (release = resolve)))
    return release
  }

  countCalls(name) {
    return this.calls.filter(c => c === name).length
  }

  // A clock that only goes forward, so "newest" is never a tie between rows
  // written in the same millisecond.
  now() {
    this.tick += 1
    return new Date(Date.now() + this.tick).toISOString()
  }

  // For bridging into a browser page, where a thrown Error can't cross.
  async call(name, args) {
    try {
      return { data: await this.api[name](...args) }
    } catch (e) {
      return {
        error: {
          message: e?.message,
          code: e?.code,
          hint: e?.hint,
          details: e?.details,
          thrown: e instanceof Error,
        },
      }
    }
  }

  findLocation(locationId) {
    for (const client of this.clients) {
      const location = client.locations.find(l => l.id === locationId)
      if (location) return location
    }
    return null
  }

  findRoom(roomId) {
    for (const client of this.clients) {
      for (const location of client.locations) {
        for (const floor of location.floors) {
          const room = floor.rooms.find(r => r.id === roomId)
          if (room) return room
        }
      }
    }
    return null
  }

  openVisitAt(locationId, kind) {
    return [...this.visits.values()].find(
      v => v.locationId === locationId && v.kind === kind && !v.completedAt,
    )
  }

  // Seeds a client with a site and rooms, as if it had always been there.
  seedClient({ id = 'c1', name = 'Equinix', locationId = 'l1', rooms = ['r1', 'r2'] } = {}) {
    this.clients.push({
      id,
      name,
      locations: [
        {
          id: locationId,
          clientId: id,
          address: '8 Grand Avenue',
          suburb: 'Rosehill',
          city: '',
          state: '',
          postcode: '',
          floors: [
            {
              id: `f-${locationId}`,
              label: 'Ground',
              position: 0,
              rooms: rooms.map((r, i) => ({ id: r, name: `Room ${r}`, planNumber: '', position: i })),
            },
          ],
        },
      ],
    })
  }

  // Another device starting a visit, with rooms it has already answered.
  seedVisit({ id, locationId = 'l1', kind = 'maintenance', technician = 'Pat', rooms = {}, ...rest }) {
    const visit = {
      id,
      locationId,
      kind,
      technician,
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      completedAt: null,
      firstCompletedAt: null,
      exportPreference: null,
      siteResults: {},
      rooms: {},
      exports: [],
      ...rest,
    }
    for (const [roomId, entry] of Object.entries(rooms)) {
      visit.rooms[roomId] = this.roomRow(id, roomId, entry)
    }
    this.visits.set(id, visit)
    this.counted += 1
    return visit
  }

  roomRow(visitId, roomId, entry) {
    return {
      id: `${visitId}/${roomId}`,
      visitId,
      roomId,
      roomName: entry.roomName ?? '',
      planNumber: entry.planNumber ?? '',
      floorLabel: entry.floorLabel ?? '',
      position: entry.position ?? 0,
      results: entry.results ?? {},
      readings: entry.readings ?? {},
      troubleshooting: entry.troubleshooting ?? {},
      sections: entry.sections ?? {},
      comments: entry.comments ?? '',
      status: entry.status === 'complete' ? 'complete' : 'in-progress',
      fails: entry.fails ?? 0,
      template: entry.template ?? {},
      updatedAt: this.now(),
    }
  }

  checkDate(what, at) {
    const t = Date.parse(at)
    if (t < Date.now() - 7 * DAY) {
      throw pg('23514', `${what} is more than 7 days ago. Older work can only come in through the one-time import.`, 'visit_date')
    }
    if (t > Date.now() + 3600000) {
      throw pg('23514', `${what} is in the future. Check the date and time on this device.`, 'visit_date')
    }
  }

  methods() {
    return {
      listClients: async () => this.clients,
      listVisitsForTeam: async () => [...this.visits.values()],
      getTeamSettings: async () => this.settings,
      getTemplates: async () => this.templates,
      getMemberPrefs: async () => this.prefs,

      getEntitlements: async () => ({
        enforced: this.visitLimit !== null,
        accountType: 'provider',
        plan: 'free',
        isPro: false,
        seatLimit: 1,
        seatsUsed: 1,
        visitLimit: this.visitLimit,
        visitsUsed: this.counted,
        packs: ['core', 'av'],
        pastDueUntil: null,
        cancelAt: null,
        importUsed: false,
        openVisits: [...this.visits.values()].filter(v => !v.completedAt).length,
        starterPack: null,
        starterInUse: false,
        ...this.plan,
      }),

      chooseStarterPack: async (_team, packId) => {
        if (this.plan.starterInUse) {
          throw pg('PT402', 'This team already has work under its current pack, so it cannot be swapped.', 'upgrade')
        }
        this.plan = { ...this.plan, starterPack: packId, packs: ['core', packId] }
        this.packRefused.clear()
      },

      saveMemberPrefs: async (_team, _user, patch) => {
        this.prefs = { ...this.prefs, ...patch }
      },
      updateTeamSettings: async (_team, patch) => {
        if (!this.admin) throw coded('Only an admin can change the company settings.', '42501')
        this.settings = { ...this.settings, ...patch }
      },
      saveTemplate: async (_team, kind, template) => {
        if (!this.admin) throw coded('Only an admin can change the shared test lists.', '42501')
        this.templates[kind] = template
      },

      createClient: async (_team, name, id) => {
        const mine = this.clients.find(c => c.id === id)
        if (mine) return mine
        if (this.clients.some(c => c.name === name)) {
          throw coded(`A client named "${name}" already exists.`, '23505')
        }
        const client = { id, name, locations: [] }
        this.clients.push(client)
        return client
      },
      renameClient: async (id, name) => {
        if (this.clients.some(c => c.id !== id && c.name === name)) {
          throw coded(`A client named "${name}" already exists.`, '23505')
        }
        const client = this.clients.find(c => c.id === id)
        if (client) client.name = name
      },
      deleteClient: async id => {
        const client = this.clients.find(c => c.id === id)
        for (const l of client?.locations ?? []) this.removeLocation(l.id)
        this.clients = this.clients.filter(c => c.id !== id)
      },

      addLocation: async (_team, clientId, details, id) => {
        const client = this.clients.find(c => c.id === clientId)
        if (!client) throw pg('23503', 'insert or update on table "locations" violates foreign key constraint')
        const mine = client.locations.find(l => l.id === id)
        if (mine) return mine
        if (client.locations.some(l => l.address === details.address && l.suburb === details.suburb)) {
          throw coded('That address and suburb already exist for this client.', '23505')
        }
        const location = {
          id,
          clientId,
          address: details.address ?? '',
          suburb: details.suburb ?? '',
          city: details.city ?? '',
          state: details.state ?? '',
          postcode: details.postcode ?? '',
          floors: [],
        }
        client.locations.push(location)
        return location
      },
      updateLocation: async (id, details) => {
        const location = this.findLocation(id)
        if (location) Object.assign(location, details, { floors: location.floors })
      },
      deleteLocation: async id => this.removeLocation(id),

      addFloor: async (_team, locationId, floor, position) => {
        const location = this.findLocation(locationId)
        if (!location) throw pg('23503', 'insert or update on table "floors" violates foreign key constraint')
        if (location.floors.some(f => f.id === floor.id)) return floor
        location.floors.push({ id: floor.id, label: floor.label ?? '', position, rooms: [] })
        return floor
      },
      updateFloor: async (id, patch) => {
        for (const client of this.clients) {
          for (const location of client.locations) {
            const floor = location.floors.find(f => f.id === id)
            if (floor) Object.assign(floor, patch)
          }
        }
      },
      deleteFloor: async id => {
        for (const client of this.clients) {
          for (const location of client.locations) {
            location.floors = location.floors.filter(f => f.id !== id)
          }
        }
      },

      addRoom: async (_team, floorId, room, position) => {
        for (const client of this.clients) {
          for (const location of client.locations) {
            const floor = location.floors.find(f => f.id === floorId)
            if (!floor) continue
            if (floor.rooms.some(r => r.id === room.id)) return room
            floor.rooms.push({
              id: room.id,
              name: room.name ?? '',
              planNumber: room.planNumber ?? '',
              roomType: room.roomType ?? '',
              position,
            })
            return room
          }
        }
        throw pg('23503', 'insert or update on table "rooms" violates foreign key constraint')
      },
      updateRoom: async (id, patch) => {
        const room = this.findRoom(id)
        if (room) Object.assign(room, patch)
      },
      deleteRoom: async id => this.removeRoom(id),

      startVisit: async (_team, locationId, kind, technician, _user, id, startedAt, completedAt) => {
        if (id && this.visits.has(id)) return this.visits.get(id)
        if (!this.findLocation(locationId)) {
          throw pg('23503', 'insert or update on table "visits" violates foreign key constraint')
        }

        // The pack and the dates are checked before the row goes in, and the
        // index answers as it goes in. Only then the counter, so joining an open
        // visit is never refused or counted.
        if (this.packRefused.has(kind)) {
          throw pg('PT402', `This team does not have the pack for ${kind}`, 'upgrade')
        }
        this.checkDate('The visit\'s start date', startedAt)
        if (completedAt) this.checkDate('The visit\'s completion date', completedAt)
        if (!completedAt) {
          const open = this.openVisitAt(locationId, kind)
          if (open) return open
        }
        if (this.visitLimit !== null && this.counted >= this.visitLimit) {
          throw pg('PT402', 'This plan includes 1 inspection a month, and this month\'s has been used', 'upgrade')
        }
        this.counted += 1

        const visit = {
          id,
          locationId,
          kind,
          technician: technician ?? '',
          startedAt,
          completedAt: completedAt ?? null,
          firstCompletedAt: completedAt ?? null,
          exportPreference: null,
          siteResults: {},
          rooms: {},
          exports: [],
        }
        this.visits.set(id, visit)
        return visit
      },

      updateVisit: async (id, patch) => {
        const visit = this.visits.get(id)
        if (!visit) throw coded('This visit has been deleted on another device.', 'VISIT_GONE')
        if ('technician' in patch) visit.technician = patch.technician ?? ''
        if ('exportPreference' in patch) visit.exportPreference = patch.exportPreference ?? null
        if ('siteResults' in patch) visit.siteResults = patch.siteResults ?? {}
        if ('completedAt' in patch && patch.completedAt !== visit.completedAt) {
          if (!patch.completedAt) {
            const open = this.openVisitAt(visit.locationId, visit.kind)
            if (open && open.id !== id) throw pg('23505', 'duplicate key value violates unique constraint')
            visit.completedAt = null
          } else if (!visit.completedAt && visit.firstCompletedAt) {
            // A reopened visit keeps the date it was first completed.
            visit.completedAt = visit.firstCompletedAt
          } else {
            this.checkDate('The visit\'s completion date', patch.completedAt)
            visit.completedAt = patch.completedAt
            visit.firstCompletedAt = visit.firstCompletedAt ?? patch.completedAt
          }
        }
        return { completedAt: visit.completedAt }
      },

      getVisitSite: async id => this.visits.get(id)?.siteResults ?? null,

      deleteVisit: async id => {
        this.visits.delete(id)
      },

      visitExists: async id => this.visits.has(id),

      getVisitRoom: async (visitId, roomId, { withTemplate = false } = {}) => {
        const row = this.visits.get(visitId)?.rooms[roomId]
        if (!row) return null
        return withTemplate ? row : { ...row, template: {} }
      },

      saveVisitRoom: async (_team, visitId, roomId, entry) => {
        const visit = this.visits.get(visitId)
        if (!visit || !this.findRoom(roomId)) {
          throw pg('23503', 'insert or update on table "visit_rooms" violates foreign key constraint')
        }
        visit.rooms[roomId] = this.roomRow(visitId, roomId, entry)
        return visit.rooms[roomId]
      },

      saveRoomlessVisitRoom: async (_team, visitId, entry) => {
        const visit = this.visits.get(visitId)
        if (!visit) throw pg('23503', 'insert or update on table "visit_rooms" violates foreign key constraint')
        visit.roomless = [...(visit.roomless ?? []), entry]
      },

      deleteVisitRoom: async (visitId, roomId) => {
        delete this.visits.get(visitId)?.rooms[roomId]
      },

      deleteExport: async (visitId, revision) => {
        const visit = this.visits.get(visitId)
        if (visit) visit.exports = visit.exports.filter(e => e.revision !== revision)
      },

      recordExport: async (_team, visitId, revision, filename) => {
        const visit = this.visits.get(visitId)
        if (!visit) throw pg('23503', 'insert or update on table "visit_exports" violates foreign key constraint')
        const record = { id: `${visitId}/${revision}`, revision, filename, createdAt: this.now() }
        visit.exports = [...visit.exports.filter(e => e.revision !== revision), record]
        return record
      },
    }
  }

  removeLocation(id) {
    for (const client of this.clients) {
      client.locations = client.locations.filter(l => l.id !== id)
    }
    for (const [visitId, visit] of this.visits) {
      if (visit.locationId === id) this.visits.delete(visitId)
    }
  }

  removeRoom(id) {
    for (const client of this.clients) {
      for (const location of client.locations) {
        for (const floor of location.floors) {
          floor.rooms = floor.rooms.filter(r => r.id !== id)
        }
      }
    }
    // on delete set null: the answers stay, against no room.
    for (const visit of this.visits.values()) {
      if (visit.rooms[id]) {
        visit.roomless = [...(visit.roomless ?? []), visit.rooms[id]]
        delete visit.rooms[id]
      }
    }
  }
}

// Same shape as a device copy store (src/lib/offlineStore.js), in memory. Several
// can share one Map, which is several tabs on one device.
export function memoryDevice(copies = new Map(), tab = 'tab-1') {
  const ownId = `user:team:${tab}`
  let seq = 0
  return {
    ownId,
    copies,
    async load() {
      const all = [...copies.values()].map(c => structuredClone(c))
      const own =
        all.find(c => c.id === ownId) ??
        [...all].sort((a, b) => b.savedAt - a.savedAt)[0] ??
        null
      return { own, others: all.filter(c => c.id !== own?.id) }
    },
    save(copy) {
      seq += 1
      copies.set(ownId, structuredClone({ ...copy, id: ownId, savedAt: Date.now() + seq / 1000 }))
    },
    async remove(ids) {
      for (const id of ids) copies.delete(id)
    },
  }
}
