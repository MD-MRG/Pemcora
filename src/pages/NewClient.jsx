import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import Field from '../components/Field.jsx'
import { useClientDraft } from '../lib/useClientDraft.js'

function AddButton({ onClick, children, tone = 'soft' }) {
  const styles =
    tone === 'strong'
      ? 'border-navy/25 bg-navy/5 text-navy hover:bg-navy/10'
      : 'border-hair bg-white text-navy hover:bg-slate-50'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[46px] w-full rounded-lg border border-dashed px-4 text-[13.5px] font-semibold transition-colors ${styles}`}
    >
      + {children}
    </button>
  )
}

/* ── Phase 1 ─────────────────────────────────────────────────────────────── */
function DetailsForm({ details, setField, complete, onSave }) {
  return (
    <section className="border-hair mx-auto max-w-2xl rounded-xl border bg-white p-5 shadow-sm">
      <h2 className="text-[15px] font-bold">Client details</h2>
      <p className="text-ink-soft mt-0.5 mb-4 text-[12.5px]">
        All six are needed before the client can be saved.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Name"
          required
          value={details.name}
          onChange={v => setField('name', v)}
          placeholder="e.g. Equinix"
          className="sm:col-span-2"
        />
        <Field
          label="Address"
          required
          value={details.address}
          onChange={v => setField('address', v)}
          placeholder="e.g. 8 Grand Avenue"
          className="sm:col-span-2"
        />
        <Field
          label="Suburb"
          required
          value={details.suburb}
          onChange={v => setField('suburb', v)}
          placeholder="e.g. Rosehill"
        />
        <Field
          label="City"
          required
          value={details.city}
          onChange={v => setField('city', v)}
          placeholder="e.g. Sydney"
        />
        <Field
          label="State"
          required
          value={details.state}
          onChange={v => setField('state', v)}
          placeholder="e.g. NSW"
        />
        <Field
          label="Postcode"
          required
          value={details.postcode}
          onChange={v => setField('postcode', v)}
          placeholder="e.g. 2142"
          inputMode="numeric"
        />
      </div>

      <button
        type="button"
        onClick={onSave}
        disabled={!complete}
        className="bg-navy mt-5 min-h-[48px] w-full rounded-lg px-4 text-[14px] font-semibold text-white transition-colors enabled:hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Save Client
      </button>
    </section>
  )
}

/* ── Phase 2 ─────────────────────────────────────────────────────────────── */
function ClientHeader({ name, totals }) {
  const stat = (n, one, many) => `${n} ${n === 1 ? one : many}`
  return (
    <header className="border-hair mx-auto mb-4 max-w-3xl rounded-xl border bg-white px-5 py-4 shadow-sm">
      <h2 className="truncate text-[19px] leading-tight font-bold">{name}</h2>
      <p className="text-ink-soft mt-1 text-[13px] tabular-nums">
        {stat(totals.floors, 'floor', 'floors')} · {stat(totals.rooms, 'room', 'rooms')}
      </p>
    </header>
  )
}

function FloorBlock({ floor, index, setFloorLabel, setRoom, addRoom, registerRef }) {
  return (
    <section className="border-hair rounded-xl border bg-white p-4 shadow-sm">
      <Field
        label={`Floor ${index + 1}`}
        value={floor.label}
        onChange={v => setFloorLabel(floor.id, v)}
        placeholder="e.g. Level 47"
        inputRef={registerRef('floor', floor.id)}
      />

      <div className="mt-4 flex flex-col gap-3">
        {floor.rooms.map((room, ri) => (
          <div key={room.id} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field
              label={ri === 0 ? 'Room' : ''}
              aria-label={`Floor ${index + 1} room ${ri + 1} name`}
              value={room.name}
              onChange={v => setRoom(floor.id, room.id, 'name', v)}
              placeholder="Room name"
              inputRef={registerRef('room', room.id)}
            />
            <Field
              label={ri === 0 ? 'Floor plan no.' : ''}
              aria-label={`Floor ${index + 1} room ${ri + 1} plan number`}
              value={room.planNumber}
              onChange={v => setRoom(floor.id, room.id, 'planNumber', v)}
              placeholder="Plan number"
            />
          </div>
        ))}
      </div>

      <div className="mt-3">
        <AddButton onClick={() => addRoom(floor.id)}>New Room</AddButton>
      </div>
    </section>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function NewClient() {
  const navigate = useNavigate()
  const draft = useClientDraft()
  const { details, floors, saved, lastAdded, detailsComplete, totals } = draft

  // Focus the entry that was just added, so a run of rooms can be typed
  // without hunting for the new input.
  const refs = useRef(new Map())
  const registerRef = (kind, id) => el => {
    if (el) refs.current.set(`${kind}:${id}`, el)
    else refs.current.delete(`${kind}:${id}`)
  }
  useEffect(() => {
    if (!lastAdded) return
    refs.current.get(`${lastAdded.type}:${lastAdded.id}`)?.focus()
  }, [lastAdded])

  if (!saved) {
    return (
      <div className="p-4 sm:p-6">
        <DetailsForm
          details={details}
          setField={draft.setField}
          complete={detailsComplete}
          onSave={draft.saveClient}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <ClientHeader name={details.name} totals={totals} />

        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {floors.map((floor, i) => (
            <FloorBlock
              key={floor.id}
              floor={floor}
              index={i}
              setFloorLabel={draft.setFloorLabel}
              setRoom={draft.setRoom}
              addRoom={draft.addRoom}
              registerRef={registerRef}
            />
          ))}

          <AddButton tone="strong" onClick={draft.addFloor}>
            Another floor
          </AddButton>
        </div>
      </div>

      <footer className="border-hair shrink-0 border-t-2 bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="bg-navy min-h-[48px] w-full rounded-lg px-4 text-[14px] font-semibold text-white hover:bg-[#24486e]"
          >
            Finished
          </button>
        </div>
      </footer>
    </div>
  )
}
