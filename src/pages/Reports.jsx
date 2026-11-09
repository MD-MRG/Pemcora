import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import Notice from '../components/Notice.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import OpenPdf from '../components/OpenPdf.jsx'
import { FileReport } from './SaveReport.jsx'
import { useTeam } from '../context/team.js'
import { entitledTeam, subscribeEntitlements } from '../lib/entitlements.js'
import { listReceivedReports, savedReportFileUrl, stopAutoFiling } from '../lib/api.js'
import { listClients, saveClientLocation } from '../lib/clientStore.js'
import { flushWithin, saveStatus, subscribe } from '../lib/cache.js'
import { classifySaveError } from '../lib/saveErrors.js'
import { propertyChoices, receivedAsPreview, reportSummary } from '../lib/reportLink.js'

// A landlord's or agency's Reports page (build plan D4b): every report saved to
// the account, the ones not filed yet first. Each opens its PDF, can be filed
// under a property (or moved to another), and a report whose site files its
// later reports by itself says so, and can stop that.
//
// The reports are the database's (received_reports(), 0013), so the page needs
// a connection. Properties are the account's own, on this device: one made here
// is saved like any other, then the report is filed under it.

const card = 'border-hair rounded-xl border bg-white p-4'

// A new property from a report's address, under its owner, in the device's own
// copy, then saved: filing needs it in the database first.
async function makeProperty(owner, site) {
  const made = saveClientLocation({
    name: owner,
    address: site?.address ?? '',
    suburb: site?.suburb ?? '',
    city: site?.city ?? '',
    state: site?.state ?? '',
    postcode: site?.postcode ?? '',
  })
  await flushWithin(10000)
  const status = saveStatus()
  if (status !== null && status !== 'saved') {
    throw new Error(
      'The new property is kept on this device but hasn’t reached the database yet. File the report under it once there is signal.',
    )
  }
  return { id: made.locationId }
}

export default function Reports() {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const { team } = useTeam()
  useSyncExternalStore(subscribe, saveStatus)
  const [state, setState] = useState(null) // { rows } or { error }
  const [filing, setFiling] = useState(null)
  const [askStop, setAskStop] = useState(null)
  const [problem, setProblem] = useState('')

  const load = useCallback(async () => {
    if (!teamId) return
    try {
      setState({ rows: await listReceivedReports(teamId) })
    } catch (e) {
      setState({
        error:
          navigator.onLine === false || classifySaveError(e) === 'network'
            ? 'Reports need a connection. They will show once you have signal.'
            : 'The reports couldn’t be loaded.',
      })
    }
  }, [teamId])

  useEffect(() => {
    load()
  }, [load])

  if (!teamId) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <p className="text-ink-soft text-[14px]">
          Reports are kept with an account. Sign in to one to see them.
        </p>
      </div>
    )
  }
  if (!state) return <p className="text-ink-soft p-6 text-[14px]">Loading…</p>
  if (state.error) {
    return (
      <div className="mx-auto max-w-4xl space-y-3 p-4 sm:p-6">
        <Notice title={state.error} />
        <button
          type="button"
          onClick={load}
          className="border-hair text-navy min-h-[40px] rounded-lg border bg-white px-4 text-[13.5px] font-semibold hover:bg-slate-50"
        >
          Try again
        </button>
      </div>
    )
  }

  const places = new Map(propertyChoices(listClients()).map(p => [p.id, p.label]))
  const account = { id: teamId, name: team?.name ?? 'your account' }
  const unfiled = state.rows.filter(r => !r.recipient_location_id)
  const filed = state.rows.filter(r => r.recipient_location_id)

  const row = r => {
    const s = reportSummary(receivedAsPreview(r))
    const where = r.recipient_location_id
      ? places.get(r.recipient_location_id) || 'a property'
      : null
    return (
      <li key={r.id} className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-ink text-[14.5px] font-semibold">
              {s.check} · {s.business}
            </p>
            <p className="text-ink-soft mt-0.5 text-[12.5px]">
              {s.site}
              {s.completedOn && ` · Done ${s.completedOn}`}
              {s.outcome && (
                <>
                  {' · '}
                  <span
                    className={
                      s.outcome === 'Compliant'
                        ? 'text-pass font-semibold'
                        : 'text-fail font-semibold'
                    }
                  >
                    {s.outcome}
                  </span>
                </>
              )}
            </p>
            <p className="text-ink mt-1 text-[12.5px]">
              {where ? `Filed under ${where}` : 'Not filed yet'}
            </p>
            {r.files_itself && (
              <p className="text-ink-soft mt-1 text-[12.5px]">
                Later reports from {s.business} for this property file themselves.{' '}
                <button
                  type="button"
                  onClick={() => setAskStop({ r, business: s.business, where })}
                  className="text-navy font-semibold underline-offset-2 hover:underline"
                >
                  Stop that
                </button>
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-start gap-2">
            <OpenPdf
              compact
              hasFile={r.has_file}
              getUrl={() => savedReportFileUrl(r.file_path)}
              label={`Open the PDF of ${s.check} for ${s.site}`}
            />
            <button
              type="button"
              onClick={() => setFiling(filing === r.id ? null : r.id)}
              className={`min-h-[38px] rounded-lg px-3 text-[13px] font-semibold ${where ? 'border-hair text-navy border hover:bg-slate-50' : 'bg-navy text-white hover:bg-[#24486e]'}`}
            >
              {where ? 'Move' : 'File it'}
            </button>
          </div>
        </div>
        {filing === r.id && (
          <div className="border-hair mt-4 border-t pt-4">
            <FileReport
              team={account}
              delivery={r}
              loadClients={listClients}
              makeProperty={makeProperty}
              subtitle={
                where
                  ? `Filed under ${where} now. Choose where it belongs.`
                  : 'Nothing in your properties has this address yet.'
              }
              onDone={async () => {
                setFiling(null)
                await load()
              }}
            />
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      {problem && <Notice blocked title={problem} />}
      {state.rows.length === 0 && (
        <div className={card}>
          <p className="text-ink text-[14px] font-semibold">No reports yet</p>
          <p className="text-ink-soft mt-1 text-[13.5px]">
            When an electrician sends you a report, open the link in their email and save it to this
            account. It appears here, filed under its property.
          </p>
        </div>
      )}
      {unfiled.length > 0 && (
        <section>
          <h2 className="text-ink-soft mb-2 text-[11.5px] font-semibold tracking-[.08em] uppercase">
            Not filed yet ({unfiled.length})
          </h2>
          <ul className="m-0 list-none space-y-3 p-0">{unfiled.map(row)}</ul>
        </section>
      )}
      {filed.length > 0 && (
        <section>
          <h2 className="text-ink-soft mb-2 text-[11.5px] font-semibold tracking-[.08em] uppercase">
            Filed
          </h2>
          <ul className="m-0 list-none space-y-3 p-0">{filed.map(row)}</ul>
        </section>
      )}

      {askStop && (
        <ConfirmDialog
          title={`Stop reports from ${askStop.business} filing themselves?`}
          confirmLabel="Stop"
          onCancel={() => setAskStop(null)}
          onConfirm={async () => {
            const { r } = askStop
            setAskStop(null)
            setProblem('')
            try {
              await stopAutoFiling(r.id)
              await load()
            } catch (e) {
              setProblem(e.message || 'That didn’t work.')
            }
          }}
        >
          Their next report for {askStop.where || 'this property'} will wait here to be filed, as a
          new one does. The reports already filed stay where they are.
        </ConfirmDialog>
      )}
    </div>
  )
}
