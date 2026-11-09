import { useEffect, useState, useSyncExternalStore } from 'react'
import Notice from '../components/Notice.jsx'
import { entitledTeam, subscribeEntitlements } from '../lib/entitlements.js'
import { getDueList, getDueOptOuts, setCheckReminders } from '../lib/api.js'
import { prefs } from '../lib/prefs.js'
import { classifySaveError } from '../lib/saveErrors.js'
import {
  clientsIn,
  dueTitle,
  groupDue,
  hasSwitch,
  lastDoneText,
  whenText,
  withOptOuts,
} from '../lib/due.js'
import { getSettings } from '../lib/settingsStore.js'

// What's due across the team's sites (build plan C4): overdue checks, those due
// in the next 60 days, sites on a regular interval not done yet, and alarms
// expiring in the next 3 months. The database works the list out from its own
// records (due_list()), so with no signal the page shows the last list this
// device was given, and says when that was.
//
// Each check has its own reminders switch (2.8). One whose client said "no
// longer needed" from a reminder email says so, from the opt-out list itself
// (due_opt_outs(), 0009), and can't be switched back on.
//
// `receiving` is a landlord's or agency's Due page (D4d): the same list across
// their properties, the checks reports keep and the ones they entered by hand.
// It has no reminder switches: reminder emails go to an electrician's clients,
// and a landlord's own list isn't emailed to anyone yet.
export default function Due({ receiving = false }) {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const [list, setList] = useState(null) // { rows, at, live } or { error }
  const [clientId, setClientId] = useState('')
  // A switch's refusal, by check.
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    if (!teamId) return undefined
    let alive = true
    Promise.all([getDueList(teamId), getDueOptOuts(teamId)])
      .then(([due, optOuts]) => {
        const rows = withOptOuts(due, optOuts)
        prefs.setLastDue(teamId, rows)
        if (alive) setList({ rows, at: null, live: true })
      })
      .catch(e => {
        if (!alive) return
        const last = prefs.getLastDue(teamId)
        if (classifySaveError(e) !== 'network')
          setList({ error: "The Due list couldn't be loaded." })
        else if (last) setList({ rows: last.rows, at: last.at, live: false })
        else
          setList({
            error:
              'The Due list needs a connection the first time. It will show once you have signal.',
          })
      })
    return () => {
      alive = false
    }
  }, [teamId])

  if (!teamId) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <p className="text-ink-soft text-[14px]">
          The Due list comes from your team's records. Sign in to a team to see it.
        </p>
      </div>
    )
  }
  if (!list) return <p className="text-ink-soft p-6 text-[14px]">Loading…</p>
  if (list.error) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <Notice title={list.error} />
      </div>
    )
  }

  const clients = clientsIn(list.rows)
  const groups = groupDue(list.rows, clientId)

  // The switch moves at once and goes back if the database says no.
  const setSwitch = (itemId, enabled) =>
    setList(l => ({
      ...l,
      rows: l.rows.map(r => (r.itemId === itemId ? { ...r, remindersEnabled: enabled } : r)),
    }))
  const toggle = async (row, enabled) => {
    setBusy(row.itemId)
    setErrors(e => ({ ...e, [row.itemId]: '' }))
    setSwitch(row.itemId, enabled)
    try {
      await setCheckReminders(row.itemId, enabled)
      prefs.setLastDue(
        teamId,
        list.rows.map(r => (r.itemId === row.itemId ? { ...r, remindersEnabled: enabled } : r)),
      )
    } catch (e) {
      setSwitch(row.itemId, !enabled)
      const said =
        e?.hint === 'opted_out'
          ? "The client turned these off from the email, so they can't be turned back on here."
          : classifySaveError(e) === 'network'
            ? 'This needs a connection. Try again once you have signal.'
            : (e?.message ?? "It wasn't saved.")
      setErrors(x => ({ ...x, [row.itemId]: said }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      {!list.live && (
        <Notice
          title={`No connection. This is the list as it was ${new Date(list.at).toLocaleString()}.`}
        >
          It updates once you have signal.
        </Notice>
      )}

      {!receiving && getSettings().remindersEnabled === false && (
        <Notice title="Reminders are switched off for the whole team in Settings.">
          None go out, whatever each check below says.
        </Notice>
      )}

      {clients.length > 1 && (
        <label className="flex items-center gap-2 text-[13.5px]">
          <span className="text-ink-soft font-semibold">{receiving ? 'Owner' : 'Client'}</span>
          <select
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            className="border-hair text-ink focus:border-navy rounded-lg border bg-white px-3 py-2 text-[14px] outline-none"
          >
            <option value="">{receiving ? 'All owners' : 'All clients'}</option>
            {clients.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {groups.length === 0 && (
        <p className="text-ink-soft text-[14px]">
          {receiving
            ? 'Nothing overdue or due in the next 60 days at your properties.'
            : 'Nothing overdue or due in the next 60 days, no site waiting on its first visit, and no alarm expiring in the next 3 months.'}
        </p>
      )}

      {groups.map(g => (
        <section
          key={g.kind}
          className="border-hair overflow-hidden rounded-xl border bg-white"
          aria-label={g.title}
        >
          <h2
            className={`border-hair border-b px-4 py-2.5 text-[11.5px] font-semibold tracking-[.08em] uppercase ${
              g.kind === 'overdue' ? 'bg-fail/10 text-fail' : 'text-ink-soft bg-slate-50'
            }`}
          >
            {g.title} <span className="font-medium">({g.rows.length})</span>
          </h2>
          <ul className="m-0 list-none p-0">
            {g.rows.map(row => (
              <li
                key={`${row.kind}:${row.itemId ?? row.assetId ?? `${row.locationId}:${row.obligation}`}`}
                className="border-hair flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b px-4 py-3 last:border-0"
              >
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold">{receiving ? row.label || dueTitle(row) : dueTitle(row)}</span>
                  <span className="text-ink-soft block text-[12.5px]">
                    {row.clientName} · {[row.address, row.suburb].filter(Boolean).join(', ')}
                  </span>
                </span>
                <span className="text-right text-[12.5px]">
                  <span
                    className={`block font-semibold ${row.kind === 'overdue' ? 'text-fail' : 'text-ink'}`}
                  >
                    {whenText(row)}
                  </span>
                  {lastDoneText(row) && (
                    <span className="text-ink-soft block">{lastDoneText(row)}</span>
                  )}
                </span>
                {!receiving && hasSwitch(row) && (
                  <div className="w-full">
                    {row.optedOutAt ? (
                      <p className="text-[12.5px]">
                        <span className="mr-2 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                          No longer needed
                        </span>
                        <span className="text-ink-soft">
                          The client said so from a reminder email on{' '}
                          {new Date(row.optedOutAt).toLocaleDateString()}. Reminders stay off.
                        </span>
                      </p>
                    ) : (
                      <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px]">
                        <input
                          type="checkbox"
                          checked={row.remindersEnabled !== false}
                          disabled={!list.live || busy === row.itemId}
                          onChange={e => toggle(row, e.target.checked)}
                          aria-label={`Reminders for ${dueTitle(row)} at ${row.address}`}
                          className="text-navy h-4 w-4 rounded disabled:opacity-50"
                        />
                        <span className="text-ink-soft">Reminders</span>
                      </label>
                    )}
                    {errors[row.itemId] && (
                      <p role="alert" className="text-fail mt-1 text-[12.5px] font-semibold">
                        {errors[row.itemId]}
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
