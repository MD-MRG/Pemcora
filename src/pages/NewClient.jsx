import { useNavigate } from 'react-router-dom'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import FloorsEditor from '../components/FloorsEditor.jsx'
import { useClientDraft } from '../lib/useClientDraft.js'

const ADDRESS_LABELS = [
  ['name', 'Name'],
  ['address', 'Address'],
  ['suburb', 'Suburb'],
  ['city', 'City'],
  ['state', 'State'],
  ['postcode', 'Postcode'],
]

// The location already on file, shown so the technician can see exactly what
// they have collided with rather than guessing.
function ExistingLocation({ clientName, existing }) {
  const values = { name: clientName, ...existing }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {ADDRESS_LABELS.map(([key, label]) => (
        <div key={key} className="contents">
          <dt className="font-semibold">{label}</dt>
          <dd className="m-0">{values[key] || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function SaveNotice({ notice }) {
  if (!notice) return null
  if (notice.kind === 'duplicate') {
    return (
      <Notice blocked title="Client and location already exist.">
        <ExistingLocation clientName={notice.clientName} existing={notice.existing} />
      </Notice>
    )
  }
  return (
    <Notice
      title={`Client "${notice.clientName}" found in the database. New location being added.`}
    />
  )
}

/* ── Phase 1 ─────────────────────────────────────────────────────────────── */
function DetailsForm({ details, setField, canSave, onSave, notice }) {
  return (
    <section className="border-hair mx-auto max-w-2xl rounded-xl border bg-white p-5 shadow-sm">
      <h2 className="text-[15px] font-bold">Client details</h2>
      <p className="text-ink-soft mt-0.5 mb-4 text-[12.5px]">
        All six are needed before the client can be saved.
      </p>

      {notice && (
        <div className="mb-4">
          <SaveNotice notice={notice} />
        </div>
      )}

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
        disabled={!canSave}
        className="bg-navy mt-5 min-h-[48px] w-full rounded-lg px-4 text-[14px] font-semibold text-white transition-colors enabled:hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Save Client
      </button>
    </section>
  )
}

/* ── Phase 2 ─────────────────────────────────────────────────────────────── */
function ClientHeader({ details, totals, saveState }) {
  const stat = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const indicator =
    saveState === 'saving'
      ? { text: 'Saving…', cls: 'text-ink-soft' }
      : saveState === 'saved'
        ? { text: 'Saved ✓', cls: 'text-pass' }
        : saveState === 'error'
          ? { text: 'Save failed', cls: 'text-fail' }
          : null

  return (
    <header className="border-hair mx-auto mb-4 max-w-3xl rounded-xl border bg-white px-5 py-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="truncate text-[19px] leading-tight font-bold">{details.name}</h2>
        {indicator && (
          <span className={`shrink-0 text-[12px] ${indicator.cls}`}>{indicator.text}</span>
        )}
      </div>
      {/* which of this client's locations is being worked on */}
      <p className="text-ink-soft mt-0.5 truncate text-[13px]">
        {[details.address, details.suburb].filter(Boolean).join(', ')}
      </p>
      <p className="text-ink-soft mt-1 text-[13px] tabular-nums">
        {stat(totals.floors, 'floor', 'floors')} · {stat(totals.rooms, 'room', 'rooms')}
      </p>
    </header>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function NewClient() {
  const navigate = useNavigate()
  const draft = useClientDraft()
  const { details, floors, saved, notice, lastAdded, canSave, totals, saveState } = draft

  if (!saved) {
    return (
      <div className="p-4 sm:p-6">
        <DetailsForm
          details={details}
          setField={draft.setField}
          canSave={canSave}
          onSave={draft.saveClient}
          notice={notice}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {notice && (
          <div className="mx-auto mb-4 max-w-3xl">
            <SaveNotice notice={notice} />
          </div>
        )}

        <ClientHeader details={details} totals={totals} saveState={saveState} />

        <div className="mx-auto max-w-3xl">
          <FloorsEditor
            floors={floors}
            lastAdded={lastAdded}
            setFloorLabel={draft.setFloorLabel}
            setRoom={draft.setRoom}
            addRoom={draft.addRoom}
            addFloor={draft.addFloor}
          />
        </div>
      </div>

      <footer className="border-hair shrink-0 border-t-2 bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <button
            type="button"
            onClick={() => {
              draft.flush() // beat the debounce, so nothing typed is lost
              navigate('/')
            }}
            className="bg-navy min-h-[48px] w-full rounded-lg px-4 text-[14px] font-semibold text-white hover:bg-[#24486e]"
          >
            Finished
          </button>
        </div>
      </footer>
    </div>
  )
}
