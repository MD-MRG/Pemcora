import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import FloorsEditor from '../components/FloorsEditor.jsx'
import { BackBar, ClientsTable, LocationsTable } from '../components/ClientBrowser.jsx'
import {
  listClients,
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

const newRoom = () => ({ id: uid(), name: '', planNumber: '' })
const newFloor = () => ({ id: uid(), label: '', rooms: [newRoom()] })

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
        <ClientsTable clients={clients} onOpen={id => setClientId(id)} />
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
      <LocationsTable
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
