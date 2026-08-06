import { useState } from 'react'
import { adapterName } from '../lib/cache.js'
import { alreadyImported, importLocalData, localSummary } from '../lib/migrate.js'
import { useAuth } from '../context/AuthContext.jsx'
import { useTeam } from '../context/TeamContext.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import Notice from './Notice.jsx'

const Check = ({ checked, onChange, label, hint }) => (
  <label className="flex items-start gap-2.5">
    <input
      type="checkbox"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      className="mt-0.5 h-4 w-4 accent-[var(--color-navy)]"
    />
    <span>
      <span className="text-ink block text-[13.5px] font-semibold">{label}</span>
      <span className="text-ink-soft block text-[12.5px]">{hint}</span>
    </span>
  </label>
)

/**
 * Offers to copy this browser's data into the signed-in team.
 *
 * Shown only when there is something to copy, a backend to copy it to, and no
 * record of having already done it for this team. It writes into a SHARED
 * team, so it is opt-in, itemised and confirmed — never something that happens
 * because a browser had data in it.
 */
export default function ImportLocalData() {
  const { user } = useAuth()
  const { team, isAdmin } = useTeam()
  const [summary] = useState(() => localSummary())
  const [want, setWant] = useState({ clients: true, settings: true, templates: true })
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)

  const offer = adapterName() === 'supabase' && summary.anything && !alreadyImported(team?.id)
  if (!offer && !report) return null

  async function run() {
    setAsking(false)
    setBusy(true)
    try {
      setReport(await importLocalData(team.id, user?.id, want))
    } catch (e) {
      setReport({ fatal: e.message })
    }
    setBusy(false)
  }

  return (
    <section className="border-hair rounded-xl border bg-card p-5">
      <h2 className="text-ink text-[15px] font-semibold">Data on this device</h2>

      {report ? (
        <div className="mt-3 space-y-3">
          {report.fatal ? (
            <Notice blocked title="The import failed">
              {report.fatal}
            </Notice>
          ) : (
            <Notice
              title={`Imported ${report.clients.imported} client${report.clients.imported === 1 ? '' : 's'} into ${team.name}.`}
            >
              {report.clients.failed.length > 0 && (
                <>
                  <p className="mb-1 font-semibold">
                    {report.clients.failed.length} could not be imported:
                  </p>
                  <ul className="list-inside list-disc">
                    {report.clients.failed.map(f => (
                      <li key={f.name}>
                        {f.name} — {f.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="mt-2">
                Nothing was removed from this device, so you can run it again if something is
                missing.
              </p>
            </Notice>
          )}
        </div>
      ) : (
        <>
          <p className="text-ink-soft mt-1.5 text-[13px] leading-snug">
            This browser still holds data saved before you signed in. Copy it into{' '}
            <b>{team?.name}</b>, where the rest of your team can see it. Nothing is removed from
            this device.
          </p>

          <div className="mt-4 space-y-2.5">
            <Check
              checked={want.clients}
              onChange={v => setWant({ ...want, clients: v })}
              label={`Clients, sites and visits — ${summary.clients} client${summary.clients === 1 ? '' : 's'}, ${summary.locations} site${summary.locations === 1 ? '' : 's'}, ${summary.rooms} room${summary.rooms === 1 ? '' : 's'}, ${summary.visits} visit${summary.visits === 1 ? '' : 's'}`}
              hint="A client whose name is already in the team is skipped, and the rest still come across."
            />
            {summary.hasSettings && (
              <Check
                checked={want.settings}
                onChange={v => setWant({ ...want, settings: v })}
                label="Company details and branding"
                hint={
                  isAdmin
                    ? 'Replaces the team’s current company details, logos and plate colour.'
                    : 'Only an admin can change these — this part will be refused.'
                }
              />
            )}
            {summary.hasTemplates && (
              <Check
                checked={want.templates}
                onChange={v => setWant({ ...want, templates: v })}
                label="Test lists"
                hint={
                  isAdmin
                    ? 'Replaces the team’s current lists, including any edits made since.'
                    : 'Only an admin can change these — this part will be refused.'
                }
              />
            )}
          </div>

          <button
            type="button"
            disabled={busy || !(want.clients || want.settings || want.templates)}
            onClick={() => setAsking(true)}
            className="bg-navy mt-4 min-h-[46px] rounded-lg px-5 text-[13.5px] font-semibold text-white hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-55"
          >
            {busy ? 'Importing…' : 'Import into this team'}
          </button>
        </>
      )}

      {asking && (
        <ConfirmDialog
          title={`Import into ${team?.name}?`}
          confirmLabel="Import"
          onCancel={() => setAsking(false)}
          onConfirm={run}
        >
          <p>
            Everyone in this team will be able to see this data.
            {(want.settings || want.templates) &&
              ' The company details and test lists you selected will replace the team’s current ones.'}
          </p>
          <p className="mt-2">Nothing is removed from this device.</p>
        </ConfirmDialog>
      )}
    </section>
  )
}
