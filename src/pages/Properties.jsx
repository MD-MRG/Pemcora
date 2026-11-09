import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import Notice from '../components/Notice.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import OpenPdf from '../components/OpenPdf.jsx'
import { entitledTeam, subscribeEntitlements } from '../lib/entitlements.js'
import {
  listComplianceItems,
  listReceivedReports,
  savedReportFileUrl,
  stopAutoFiling,
} from '../lib/api.js'
import { listClients, saveClientLocation } from '../lib/clientStore.js'
import { outsideChanges, saveStatus, subscribe } from '../lib/cache.js'
import { ownersOf, propertyCards } from '../lib/properties.js'
import { STATES } from '../lib/signup.js'
import { useEntitlements } from '../context/team.js'
import { AddCheck, OwnCheckActions } from './OwnChecks.jsx'

// A landlord's or agency's Properties page (build plan D4c): each property,
// under its owner, with what is due there and the reports filed under it.
//
// The properties are the account's own, on the device, so the list and "Add a
// property" work with no signal. What's due and the reports are the database's
// (compliance_items, received_reports()), so they need a connection, and the
// page says so when it hasn't got them.

const card = 'border-hair rounded-xl border bg-white p-4'
const input =
  'border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none'
const label = 'text-ink-soft mb-1 block text-[12.5px] font-semibold'

const TONE = {
  overdue: 'text-fail font-semibold',
  soon: 'text-amber-700 font-semibold',
  ok: 'text-ink',
  unknown: 'text-ink-soft',
}
const WHEN = {
  overdue: c => `Overdue since ${c.nextDue}`,
  soon: c => `Due ${c.nextDue}`,
  ok: c => `Due ${c.nextDue}`,
  unknown: () => 'No date on record yet',
}

function AddProperty({ owners, onAdded, onCancel }) {
  const [d, setD] = useState({
    name: owners.length === 1 ? owners[0] : '',
    address: '',
    suburb: '',
    state: '',
    postcode: '',
  })
  const [problem, setProblem] = useState('')
  const set = (k, v) => setD(x => ({ ...x, [k]: v }))
  const ready = d.name.trim() && d.address.trim() && d.suburb.trim()

  return (
    <form
      className={`${card} space-y-3`}
      onSubmit={e => {
        e.preventDefault()
        if (!ready) return
        const made = saveClientLocation({
          ...d,
          name: d.name.trim(),
          address: d.address.trim(),
          suburb: d.suburb.trim(),
          city: '',
        })
        if (made.outcome === 'duplicate')
          return setProblem(
            `${d.address.trim()}, ${d.suburb.trim()} is already a property of ${d.name.trim()}.`,
          )
        onAdded()
      }}
    >
      <p className="text-ink text-[14px] font-semibold">Add a property</p>
      <label className="block">
        <span className={label}>Owner</span>
        <input
          value={d.name}
          onChange={e => set('name', e.target.value)}
          list="property-owners"
          aria-label="Owner"
          className={input}
        />
        <datalist id="property-owners">
          {owners.map(o => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={label}>Street address</span>
          <input
            value={d.address}
            onChange={e => set('address', e.target.value)}
            aria-label="Street address"
            className={input}
          />
        </label>
        <label className="block">
          <span className={label}>Suburb</span>
          <input
            value={d.suburb}
            onChange={e => set('suburb', e.target.value)}
            aria-label="Suburb"
            className={input}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={label}>State</span>
            <select
              value={d.state}
              onChange={e => set('state', e.target.value)}
              aria-label="State"
              className={input}
            >
              <option value="" />
              {STATES.map(s => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Postcode</span>
            <input
              value={d.postcode}
              onChange={e => set('postcode', e.target.value)}
              aria-label="Postcode"
              className={input}
            />
          </label>
        </div>
      </div>
      {problem && <Notice blocked title={problem} />}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!ready}
          className="bg-navy min-h-[42px] rounded-lg px-4 text-[13.5px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:opacity-40"
        >
          Add property
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border-hair text-ink-soft min-h-[42px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

export default function Properties() {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  useSyncExternalStore(subscribe, saveStatus)
  useSyncExternalStore(subscribe, outsideChanges)
  const [, redraw] = useState(0)
  const [remote, setRemote] = useState(null) // { items, reports } or { missing }
  const [adding, setAdding] = useState(false)
  const [askStop, setAskStop] = useState(null)
  const [problem, setProblem] = useState('')
  const [addingCheck, setAddingCheck] = useState(null)
  const entitlements = useEntitlements()
  // Pro's, once the limits are on (D6); the database says the same.
  const canKeepCertificates = !(entitlements?.enforced && !entitlements.isPro)

  const load = useCallback(async () => {
    if (!teamId) return
    try {
      const [items, reports] = await Promise.all([
        listComplianceItems(teamId),
        listReceivedReports(teamId),
      ])
      setRemote({ items, reports })
    } catch {
      setRemote({ missing: true, items: [], reports: [] })
    }
  }, [teamId])

  useEffect(() => {
    load()
  }, [load])

  if (!teamId) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <p className="text-ink-soft text-[14px]">
          Properties are kept with an account. Sign in to one to see them.
        </p>
      </div>
    )
  }

  const clients = listClients()
  const cards = propertyCards(clients, remote?.items, remote?.reports)

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      {remote?.missing && (
        <div className="space-y-2">
          <Notice title="What’s due and the reports on file need a connection.">
            Your properties are here; the rest shows once there is signal.
          </Notice>
          <button
            type="button"
            onClick={load}
            className="border-hair text-navy min-h-[40px] rounded-lg border bg-white px-4 text-[13.5px] font-semibold hover:bg-slate-50"
          >
            Try again
          </button>
        </div>
      )}
      {problem && <Notice blocked title={problem} />}

      {adding ? (
        <AddProperty
          owners={ownersOf(clients)}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            redraw(n => n + 1)
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border-hair text-navy min-h-[44px] w-full rounded-xl border border-dashed bg-white text-[13.5px] font-semibold hover:bg-slate-50"
        >
          + Add a property
        </button>
      )}

      {cards.length === 0 && !adding && (
        <div className={card}>
          <p className="text-ink text-[14px] font-semibold">No properties yet</p>
          <p className="text-ink-soft mt-1 text-[13.5px]">
            Add one, or save a report from an electrician’s email: it can make the property from the
            report’s address.
          </p>
        </div>
      )}

      <ul className="m-0 list-none space-y-3 p-0">
        {cards.map(p => (
          <li key={p.id} className={card} aria-label={p.address}>
            <p className="text-ink text-[15px] font-semibold">{p.address}</p>
            <p className="text-ink-soft text-[12.5px]">{p.owner}</p>

            <div className="mt-3">
              <p className="text-ink-soft mb-1 text-[11.5px] font-semibold tracking-[.08em] uppercase">
                Due
              </p>
              {p.checks.length === 0 ? (
                <p className="text-ink-soft text-[13px]">
                  {remote && !remote.missing
                    ? 'Nothing on record yet. A saved report adds its check, or add one yourself.'
                    : '—'}
                </p>
              ) : (
                <ul className="m-0 list-none space-y-1 p-0">
                  {p.checks.map(c => (
                    <li key={c.id} className="text-[13px]">
                      <div className="flex flex-wrap justify-between gap-x-4">
                        <span className="text-ink">{c.label}</span>
                        <span className={TONE[c.state]}>
                          {WHEN[c.state](c)}
                          {c.lastDone && (
                            <span className="text-ink-soft font-normal">
                              {' '}
                              · last done {c.lastDone}
                            </span>
                          )}
                        </span>
                      </div>
                      {c.own && (
                        <OwnCheckActions
                          check={c}
                          teamId={teamId}
                          canKeepCertificates={canKeepCertificates}
                          onChanged={load}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {addingCheck === p.id ? (
                <AddCheck
                  teamId={teamId}
                  locationId={p.id}
                  onCancel={() => setAddingCheck(null)}
                  onDone={async () => {
                    setAddingCheck(null)
                    await load()
                  }}
                />
              ) : (
                remote &&
                !remote.missing && (
                  <button
                    type="button"
                    onClick={() => setAddingCheck(p.id)}
                    aria-label={`Add a check at ${p.address}`}
                    className="text-navy mt-2 text-[12.5px] font-semibold underline-offset-2 hover:underline"
                  >
                    + Add a check
                  </button>
                )
              )}
            </div>

            {p.reports.length > 0 && (
              <div className="mt-3">
                <p className="text-ink-soft mb-1 text-[11.5px] font-semibold tracking-[.08em] uppercase">
                  Reports on file
                </p>
                <ul className="m-0 list-none space-y-2 p-0">
                  {p.reports.map(r => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 text-[13px]"
                    >
                      <span className="text-ink min-w-0">
                        {r.check} · {r.business}
                        <span className="text-ink-soft"> · {r.completedOn}</span>
                      </span>
                      <OpenPdf
                        compact
                        hasFile={r.hasFile}
                        getUrl={() => savedReportFileUrl(r.filePath)}
                        label={`Open the PDF of ${r.check}, ${r.completedOn}`}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {p.selfFiling.map(f => (
              <p key={f.deliveryId} className="text-ink-soft mt-3 text-[12.5px]">
                Reports from {f.business} for this property file themselves.{' '}
                <button
                  type="button"
                  onClick={() => setAskStop({ ...f, where: p.address })}
                  className="text-navy font-semibold underline-offset-2 hover:underline"
                >
                  Stop that
                </button>
              </p>
            ))}
          </li>
        ))}
      </ul>

      {askStop && (
        <ConfirmDialog
          title={`Stop reports from ${askStop.business} filing themselves?`}
          confirmLabel="Stop"
          onCancel={() => setAskStop(null)}
          onConfirm={async () => {
            const { deliveryId } = askStop
            setAskStop(null)
            setProblem('')
            try {
              await stopAutoFiling(deliveryId)
              await load()
            } catch (e) {
              setProblem(e.message || 'That didn’t work.')
            }
          }}
        >
          Their next report for {askStop.where} will wait on the Reports page to be filed. The
          reports already filed stay where they are.
        </ConfirmDialog>
      )}
    </div>
  )
}
