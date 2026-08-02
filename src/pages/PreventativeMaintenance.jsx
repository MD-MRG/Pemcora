import { useState, useCallback, useMemo } from 'react'
import Field from '../components/Field.jsx'
import { BackBar, ClientsTable, LocationsTable } from '../components/ClientBrowser.jsx'
import {
  listClients,
  listVisits,
  startVisit,
  roomsWithStatus,
  addRoomToLocation,
} from '../lib/clientStore.js'

const fmt = iso => (iso ? new Date(iso).toLocaleDateString() : '')

const STATUS = {
  'not-started': { label: 'Not started', cls: 'bg-slate-100 text-ink-soft' },
  'in-progress': { label: 'In progress', cls: 'bg-amber-100 text-amber-800' },
  complete: { label: 'Complete', cls: 'bg-green-100 text-pass' },
}

function StatusChip({ status, fails }) {
  if (status === 'complete' && fails > 0) {
    return (
      <span className="bg-fail/10 text-fail rounded-full px-2.5 py-1 text-[11.5px] font-semibold">
        {fails} FAIL{fails === 1 ? '' : 's'}
      </span>
    )
  }
  const s = STATUS[status] ?? STATUS['not-started']
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${s.cls}`}>{s.label}</span>
  )
}

/* ── The visit state card — one place, one primary action ─────────────────── */
function VisitCard({ visit, roomCount, doneCount, onStart, onContinue }) {
  const open = visit && !visit.completedAt

  return (
    <section className="border-hair mb-4 rounded-xl border bg-white p-5 shadow-sm">
      {!visit ? (
        <>
          <h3 className="text-[15px] font-bold">No PM recorded for this location</h3>
          <p className="text-ink-soft mt-1 text-[13px]">
            Starting a visit records the date and tracks which rooms are done.
          </p>
        </>
      ) : open ? (
        <>
          <h3 className="text-[15px] font-bold">Preventative Maintenance in progress</h3>
          <p className="text-ink-soft mt-1 text-[13px] tabular-nums">
            Started {fmt(visit.startedAt)} · {doneCount} of {roomCount} rooms complete
          </p>
        </>
      ) : (
        <>
          <h3 className="text-[15px] font-bold">Last visit completed {fmt(visit.completedAt)}</h3>
          <p className="text-ink-soft mt-1 text-[13px]">
            {visit.exports?.length
              ? `${visit.exports.length} report(s) exported`
              : 'No report exported yet'}
          </p>
        </>
      )}

      <button
        type="button"
        onClick={open ? onContinue : onStart}
        className="bg-navy mt-4 min-h-[46px] rounded-lg px-5 text-[14px] font-semibold text-white hover:bg-[#24486e]"
      >
        {open ? 'Continue' : visit ? 'Start new visit' : 'Start PM'}
      </button>
    </section>
  )
}

/* ── Add room — a floor is required, so the room lands in the right place ─── */
function AddRoomForm({ floors, onAdd, onCancel }) {
  const [floorId, setFloorId] = useState(floors[0]?.id ?? '__new')
  const [newFloorLabel, setNewFloorLabel] = useState('')
  const [name, setName] = useState('')
  const [planNumber, setPlanNumber] = useState('')

  const creatingFloor = floorId === '__new'
  const ready = name.trim() && (!creatingFloor || newFloorLabel.trim())

  return (
    <section className="border-hair mb-4 rounded-xl border bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-[15px] font-bold">Add room</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">
            Floor <span className="text-fail">*</span>
          </span>
          <select
            value={floorId}
            onChange={e => setFloorId(e.target.value)}
            aria-label="Floor"
            className="border-hair text-ink focus:border-navy min-h-[44px] w-full rounded-lg border bg-white px-3 text-[14.5px] outline-none"
          >
            {floors.map(f => (
              <option key={f.id} value={f.id}>
                {f.label || 'Unnamed floor'}
              </option>
            ))}
            <option value="__new">+ New floor…</option>
          </select>
        </label>

        {creatingFloor && (
          <Field
            label="New floor name"
            required
            value={newFloorLabel}
            onChange={setNewFloorLabel}
            placeholder="e.g. Level 47"
            className="sm:col-span-2"
          />
        )}

        <Field
          label="Room name"
          required
          value={name}
          onChange={setName}
          placeholder="e.g. Boardroom"
        />
        <Field
          label="Floor plan no."
          value={planNumber}
          onChange={setPlanNumber}
          placeholder="Plan number"
        />
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() =>
            onAdd({ floorId: creatingFloor ? null : floorId, newFloorLabel, name, planNumber })
          }
          className="bg-navy min-h-[44px] rounded-lg px-5 text-[13.5px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add room
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border-hair text-ink-soft min-h-[44px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </section>
  )
}

/* ── Level 3 · visit overview ─────────────────────────────────────────────── */
function VisitLevel({ client, location, onBack, onOpenRoom, onChanged }) {
  const [adding, setAdding] = useState(false)

  const visits = listVisits(client.id, location.id)
  const current = visits.find(v => !v.completedAt) ?? visits[0] ?? null
  // Statuses come from the most recent visit whether it is open or finished —
  // before a new visit starts, the list should still show what the last one
  // found rather than pretending nothing has been tested.
  const rooms = roomsWithStatus(client.id, location.id, current)
  const done = rooms.filter(r => r.status === 'complete').length

  // Group rooms under their floor, preserving floor order.
  const grouped = useMemo(() => {
    const map = new Map()
    for (const r of rooms) {
      if (!map.has(r.floorId)) map.set(r.floorId, { label: r.floorLabel, rooms: [] })
      map.get(r.floorId).rooms.push(r)
    }
    return [...map.entries()]
  }, [rooms])

  const floors = (location.floors ?? []).map(f => ({ id: f.id, label: f.label }))

  return (
    <>
      <BackBar
        title={`Preventative Maintenance — ${client.name}`}
        subtitle={[location.address, location.suburb].filter(Boolean).join(', ')}
        onBack={onBack}
      />

      <VisitCard
        visit={current}
        roomCount={rooms.length}
        doneCount={done}
        onStart={() => {
          startVisit(client.id, location.id)
          onChanged()
        }}
        onContinue={() => {
          const first = rooms.find(r => r.status !== 'complete') ?? rooms[0]
          if (first) onOpenRoom(first.id)
        }}
      />

      {adding ? (
        <AddRoomForm
          floors={floors}
          onCancel={() => setAdding(false)}
          onAdd={payload => {
            addRoomToLocation(client.id, location.id, payload)
            setAdding(false)
            onChanged()
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border-hair text-navy mb-4 min-h-[46px] w-full rounded-lg border border-dashed px-4 text-[13.5px] font-semibold hover:bg-slate-50"
        >
          + Add room
        </button>
      )}

      {rooms.length === 0 ? (
        <p className="text-ink-soft text-[14px]">
          No rooms recorded for this location yet — add them as you work through the site.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map(([floorId, group]) => (
            <section
              key={floorId}
              className="border-hair overflow-hidden rounded-xl border bg-white"
            >
              <h3 className="border-hair text-ink-soft border-b bg-slate-50 px-4 py-2.5 text-[11.5px] font-semibold tracking-[.08em] uppercase">
                {group.label || 'Unnamed floor'}
              </h3>
              <ul className="m-0 list-none p-0">
                {group.rooms.map(room => (
                  <li key={room.id} className="border-hair border-b last:border-0">
                    <button
                      type="button"
                      onClick={() => onOpenRoom(room.id)}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold">
                          {room.name || 'Unnamed room'}
                        </span>
                        {room.planNumber && (
                          <span className="text-ink-soft block text-[12px]">
                            Plan {room.planNumber}
                          </span>
                        )}
                      </span>
                      <StatusChip status={room.status} fails={room.fails} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {visits.length > 1 && (
        <section className="mt-6">
          <h3 className="text-ink-soft mb-2 text-[11.5px] font-semibold tracking-[.08em] uppercase">
            Past visits
          </h3>
          <ul className="border-hair m-0 list-none overflow-hidden rounded-xl border bg-white p-0">
            {visits
              .filter(v => v.id !== current?.id)
              .map(v => (
                <li
                  key={v.id}
                  className="border-hair text-ink-soft border-b px-4 py-2.5 text-[13px] last:border-0"
                >
                  {v.completedAt ? `Completed ${fmt(v.completedAt)}` : `Started ${fmt(v.startedAt)}`}
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  )
}

/* ── Level 4 · room tests (stage 2 fills this in) ─────────────────────────── */
function RoomLevel({ client, location, roomId, onBack }) {
  const room = roomsWithStatus(client.id, location.id, null).find(r => r.id === roomId)
  return (
    <>
      <BackBar
        title={room?.name || 'Room'}
        subtitle={`${client.name} · ${room?.floorLabel || 'Unnamed floor'}`}
        onBack={onBack}
      />
      <div className="border-hair rounded-xl border bg-white p-5 shadow-sm">
        <p className="text-ink-soft text-[14px]">
          The test list, section toggles, troubleshooting and comments arrive in stage 2.
        </p>
      </div>
    </>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function PreventativeMaintenance() {
  const [clients, setClients] = useState(() => listClients())
  const [clientId, setClientId] = useState(null)
  const [locationId, setLocationId] = useState(null)
  const [roomId, setRoomId] = useState(null)

  const refresh = useCallback(() => setClients(listClients()), [])
  const client = clients.find(c => c.id === clientId) ?? null
  const location = client?.locations.find(l => l.id === locationId) ?? null

  if (!client) {
    return (
      <div className="p-4 sm:p-6">
        <ClientsTable clients={clients} onOpen={setClientId} />
      </div>
    )
  }

  if (!location) {
    return (
      <div className="p-4 sm:p-6">
        <LocationsTable
          client={client}
          onBack={() => {
            setClientId(null)
            refresh()
          }}
          onOpen={setLocationId}
        />
      </div>
    )
  }

  if (roomId) {
    return (
      <div className="p-4 sm:p-6">
        <RoomLevel
          client={client}
          location={location}
          roomId={roomId}
          onBack={() => {
            setRoomId(null)
            refresh()
          }}
        />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6">
      <VisitLevel
        client={client}
        location={location}
        onBack={() => {
          setLocationId(null)
          refresh()
        }}
        onOpenRoom={setRoomId}
        onChanged={refresh}
      />
    </div>
  )
}
