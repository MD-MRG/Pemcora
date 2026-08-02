import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import FloorsEditor from '../components/FloorsEditor.jsx'
import {
  listClients,
  distinctValues,
  normalise,
  saveEditedLocation,
  addLocationToClient,
  saveFloors,
  uid,
} from '../lib/clientStore.js'

const DETAIL_FIELDS = ['name', 'address', 'suburb', 'city', 'state', 'postcode']
const ADDRESS_LABELS = [
  ['name', 'Name'],
  ['address', 'Address'],
  ['suburb', 'Suburb'],
  ['city', 'City'],
  ['state', 'State'],
  ['postcode', 'Postcode'],
]

const uniq = xs => [...new Set(xs.filter(Boolean))]
const newRoom = () => ({ id: uid(), name: '', planNumber: '' })
const newFloor = () => ({ id: uid(), label: '', rooms: [newRoom()] })

function BackBar({ title, subtitle, onBack, right }) {
  return (
    <div className="border-hair mb-4 flex items-center justify-between gap-3 border-b pb-3">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="border-hair text-navy min-h-[38px] shrink-0 rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50"
        >
          ← Back
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-[17px] leading-tight font-bold">{title}</h2>
          {subtitle && <p className="text-ink-soft truncate text-[12.5px]">{subtitle}</p>}
        </div>
      </div>
      {right}
    </div>
  )
}

/* ── Level 1 · clients ───────────────────────────────────────────────────── */
function ClientsLevel({ clients, onOpen }) {
  const [query, setQuery] = useState('')
  const [field, setField_] = useState('all')
  const [value, setValue] = useState('')

  const options = useMemo(() => (field === 'all' ? [] : distinctValues(field)), [field, clients])

  const rows = useMemo(() => {
    const q = normalise(query)
    return clients
      .filter(c => (q ? normalise(c.name).includes(q) : true))
      // A client stays in the list if ANY of its locations matches, so a
      // Melbourne site doesn't hide Equinix when filtering by NSW.
      .filter(c =>
        field === 'all' || !value
          ? true
          : c.locations.some(l => normalise(l[field]) === normalise(value)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [clients, query, field, value])

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="min-w-[220px] flex-1">
          <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">
            Search by name
          </span>
          <span className="relative block">
            <span aria-hidden="true" className="text-ink-soft absolute top-1/2 left-3 -translate-y-1/2">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4.5 4.5" />
              </svg>
            </span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Client name"
              className="border-hair text-ink w-full rounded-lg border bg-white py-2.5 pr-3 pl-9 text-[14.5px] outline-none focus:border-navy"
            />
          </span>
        </label>

        <label>
          <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">Filter</span>
          <select
            value={field}
            onChange={e => {
              setField_(e.target.value)
              setValue('')
            }}
            className="border-hair text-ink min-h-[44px] rounded-lg border bg-white px-3 text-[14px] outline-none focus:border-navy"
          >
            <option value="all">All</option>
            <option value="state">State</option>
            <option value="city">City</option>
          </select>
        </label>

        {field !== 'all' && (
          <label>
            <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold capitalize">
              {field}
            </span>
            <select
              value={value}
              onChange={e => setValue(e.target.value)}
              aria-label={`Filter by ${field}`}
              className="border-hair text-ink min-h-[44px] rounded-lg border bg-white px-3 text-[14px] outline-none focus:border-navy"
            >
              <option value="">Any</option>
              {options.map(o => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {clients.length === 0 ? (
        <p className="text-ink-soft text-[14px]">
          No clients yet — add one from the New Client page.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-ink-soft text-[14px]">No clients match that search.</p>
      ) : (
        <div className="border-hair overflow-x-auto rounded-xl border bg-white">
          <table className="w-full border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-hair text-ink-soft border-b bg-slate-50 text-[11.5px] tracking-[.08em] uppercase">
                <th className="px-4 py-3 font-semibold">Client</th>
                <th className="px-4 py-3 font-semibold">State</th>
                <th className="px-4 py-3 font-semibold">City</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => {
                const states = uniq(c.locations.map(l => l.state))
                const cities = uniq(c.locations.map(l => l.city))
                return (
                  <tr
                    key={c.id}
                    onClick={() => onOpen(c.id)}
                    className="border-hair cursor-pointer border-b last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3">
                      <button type="button" className="text-left font-semibold">
                        {c.name}
                      </button>
                      {c.locations.length > 1 && (
                        <span className="bg-navy/8 text-navy ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold">
                          {c.locations.length} locations
                        </span>
                      )}
                    </td>
                    <td className="text-ink-soft px-4 py-3">{states.join(', ') || '—'}</td>
                    <td className="text-ink-soft px-4 py-3">{cities.join(', ') || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/* ── Level 2 · locations ─────────────────────────────────────────────────── */
function LocationsLevel({ client, onBack, onOpen }) {
  return (
    <>
      <BackBar title={client.name} subtitle={`${client.locations.length} location(s)`} onBack={onBack} />
      <div className="border-hair overflow-x-auto rounded-xl border bg-white">
        <table className="w-full border-collapse text-left text-[14px]">
          <thead>
            <tr className="border-hair text-ink-soft border-b bg-slate-50 text-[11.5px] tracking-[.08em] uppercase">
              <th className="px-4 py-3 font-semibold">State</th>
              <th className="px-4 py-3 font-semibold">City</th>
              <th className="px-4 py-3 font-semibold">Street address</th>
              <th className="px-4 py-3 font-semibold">Suburb</th>
              <th className="px-4 py-3 font-semibold">Postcode</th>
            </tr>
          </thead>
          <tbody>
            {client.locations.map(l => (
              <tr
                key={l.id}
                onClick={() => onOpen(l.id)}
                className="border-hair cursor-pointer border-b last:border-0 hover:bg-slate-50"
              >
                <td className="px-4 py-3">{l.state || '—'}</td>
                <td className="px-4 py-3">{l.city || '—'}</td>
                <td className="px-4 py-3 font-semibold">{l.address || '—'}</td>
                <td className="px-4 py-3">{l.suburb || '—'}</td>
                <td className="px-4 py-3 tabular-nums">{l.postcode || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ── Level 3 · edit a location ───────────────────────────────────────────── */
function EditLevel({ client, locationId, isNew, onBack, onSaved, onAddLocation }) {
  const location = isNew ? null : client.locations.find(l => l.id === locationId)

  const initial = useMemo(
    () =>
      isNew
        ? { name: client.name, address: '', suburb: '', city: '', state: '', postcode: '' }
        : {
            name: client.name,
            address: location.address,
            suburb: location.suburb,
            city: location.city,
            state: location.state,
            postcode: location.postcode,
          },
    [client.name, location, isNew],
  )

  const [details, setDetails] = useState(initial)
  const [notice, setNotice] = useState(null)
  const [blockedKey, setBlockedKey] = useState(null)
  const [floors, setFloors] = useState(() =>
    isNew ? [] : location.floors.length ? location.floors : [newFloor()],
  )
  const [lastAdded, setLastAdded] = useState(null)
  const [saveState, setSaveState] = useState('idle')

  const setField = (k, v) => setDetails(d => ({ ...d, [k]: v }))

  const complete = DETAIL_FIELDS.every(k => details[k].trim().length > 0)
  const dirty = DETAIL_FIELDS.some(k => details[k].trim() !== initial[k].trim())
  const identityKey = [details.name, details.address, details.suburb].map(normalise).join('|')
  const isBlocked = blockedKey !== null && blockedKey === identityKey
  const canSave = complete && (dirty || isNew) && !isBlocked

  const save = () => {
    if (!canSave) return
    const result = isNew
      ? addLocationToClient(client.id, details)
      : saveEditedLocation(client.id, locationId, details)

    if (result.outcome === 'duplicate') {
      setBlockedKey(identityKey)
      setNotice({ kind: 'duplicate', clientName: details.name.trim(), existing: result.existing })
      return
    }
    if (result.outcome === 'name-conflict') {
      setBlockedKey(identityKey)
      setNotice({ kind: 'name-conflict', conflictName: result.conflictName })
      return
    }
    setBlockedKey(null)
    setNotice({ kind: 'saved' })
    onSaved(result.locationId ?? locationId)
  }

  // Floors autosave; the six identity fields wait for Save Changes.
  const timer = useRef(null)
  const floorsRef = useRef(floors)
  useEffect(() => {
    floorsRef.current = floors
  }, [floors])
  useEffect(() => {
    if (isNew || !location) return
    setSaveState('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setSaveState(saveFloors(client.id, locationId, floorsRef.current) ? 'saved' : 'error')
    }, 500)
    return () => clearTimeout(timer.current)
  }, [floors, isNew, location, client.id, locationId])

  const setFloorLabel = useCallback((floorId, label) => {
    setFloors(fs => fs.map(f => (f.id === floorId ? { ...f, label } : f)))
  }, [])
  const setRoom = useCallback((floorId, roomId, key, value) => {
    setFloors(fs =>
      fs.map(f =>
        f.id === floorId
          ? { ...f, rooms: f.rooms.map(r => (r.id === roomId ? { ...r, [key]: value } : r)) }
          : f,
      ),
    )
  }, [])
  const addRoom = useCallback(floorId => {
    const room = newRoom()
    setFloors(fs => fs.map(f => (f.id === floorId ? { ...f, rooms: [...f.rooms, room] } : f)))
    setLastAdded({ type: 'room', id: room.id })
  }, [])
  const addFloor = useCallback(() => {
    const floor = newFloor()
    setFloors(fs => [...fs, floor])
    setLastAdded({ type: 'floor', id: floor.id })
  }, [])

  const indicator =
    saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : saveState === 'error' ? 'Save failed' : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <BackBar
          title={`Edit ${client.name}`}
          subtitle={isNew ? 'New location' : [location.address, location.suburb].filter(Boolean).join(', ')}
          onBack={onBack}
          right={
            indicator && !isNew ? (
              <span className={`shrink-0 text-[12px] ${saveState === 'error' ? 'text-fail' : saveState === 'saved' ? 'text-pass' : 'text-ink-soft'}`}>
                {indicator}
              </span>
            ) : null
          }
        />

        {notice && (
          <div className="mb-4">
            {notice.kind === 'duplicate' ? (
              <Notice blocked title="Client and location already exist.">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  {ADDRESS_LABELS.map(([key, label]) => (
                    <div key={key} className="contents">
                      <dt className="font-semibold">{label}</dt>
                      <dd className="m-0">
                        {(key === 'name' ? notice.clientName : notice.existing[key]) || '—'}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Notice>
            ) : notice.kind === 'name-conflict' ? (
              <Notice
                blocked
                title={`A different client named "${notice.conflictName}" already exists.`}
              >
                Renaming would merge the two. Use a different name, or rename the other client first.
              </Notice>
            ) : (
              <Notice title="Changes added." />
            )}
          </div>
        )}

        <section className="border-hair mb-4 rounded-xl border bg-white p-5 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required value={details.name} onChange={v => setField('name', v)} className="sm:col-span-2" />
            <Field label="Address" required value={details.address} onChange={v => setField('address', v)} className="sm:col-span-2" />
            <Field label="Suburb" required value={details.suburb} onChange={v => setField('suburb', v)} />
            <Field label="City" required value={details.city} onChange={v => setField('city', v)} />
            <Field label="State" required value={details.state} onChange={v => setField('state', v)} />
            <Field label="Postcode" required value={details.postcode} onChange={v => setField('postcode', v)} inputMode="numeric" />
          </div>
        </section>

        {/* A new location has to exist before floors can attach to it. */}
        {!isNew && (
          <FloorsEditor
            floors={floors}
            lastAdded={lastAdded}
            setFloorLabel={setFloorLabel}
            setRoom={setRoom}
            addRoom={addRoom}
            addFloor={addFloor}
          />
        )}
      </div>

      <footer className="border-hair mt-4 flex shrink-0 items-center justify-between gap-3 border-t-2 bg-white py-3">
        <button
          type="button"
          onClick={onAddLocation}
          className="border-hair text-navy min-h-[46px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50"
        >
          + Add location
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="bg-navy min-h-[46px] rounded-lg px-5 text-[14px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save Changes
        </button>
      </footer>
    </div>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function EditClient() {
  const [clients, setClients] = useState(() => listClients())
  const [clientId, setClientId] = useState(null)
  const [locationId, setLocationId] = useState(null)
  const [addingLocation, setAddingLocation] = useState(false)

  const refresh = useCallback(() => setClients(listClients()), [])
  const client = clients.find(c => c.id === clientId) ?? null

  if (!client) {
    return (
      <div className="p-4 sm:p-6">
        <ClientsLevel clients={clients} onOpen={id => setClientId(id)} />
      </div>
    )
  }

  if (locationId || addingLocation) {
    return (
      <div className="flex h-full flex-col p-4 sm:p-6">
        <EditLevel
          key={addingLocation ? 'new' : locationId}
          client={client}
          locationId={locationId}
          isNew={addingLocation}
          onBack={() => {
            setLocationId(null)
            setAddingLocation(false)
            refresh()
          }}
          onSaved={newId => {
            refresh()
            if (addingLocation) {
              setAddingLocation(false)
              setLocationId(newId)
            }
          }}
          onAddLocation={() => {
            setLocationId(null)
            setAddingLocation(true)
          }}
        />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6">
      <LocationsLevel
        client={client}
        onBack={() => {
          setClientId(null)
          refresh()
        }}
        onOpen={id => setLocationId(id)}
      />
    </div>
  )
}
