import { useEffect, useState, useSyncExternalStore } from 'react'
import Notice from '../components/Notice.jsx'
import { entitledTeam, subscribeEntitlements } from '../lib/entitlements.js'
import { getDueList } from '../lib/api.js'
import { prefs } from '../lib/prefs.js'
import { classifySaveError } from '../lib/saveErrors.js'
import { clientsIn, dueTitle, groupDue, lastDoneText, whenText } from '../lib/due.js'

// What's due across the team's sites (build plan C4): overdue checks, those due
// in the next 60 days, sites on a regular interval not done yet, and alarms
// expiring in the next 3 months. The database works the list out from its own
// records (due_list()), so with no signal the page shows the last list this
// device was given, and says when that was.
export default function Due() {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const [list, setList] = useState(null) // { rows, at, live } or { error }
  const [clientId, setClientId] = useState('')

  useEffect(() => {
    if (!teamId) return undefined
    let alive = true
    getDueList(teamId)
      .then(rows => {
        prefs.setLastDue(teamId, rows)
        if (alive) setList({ rows, at: null, live: true })
      })
      .catch(e => {
        if (!alive) return
        const last = prefs.getLastDue(teamId)
        if (classifySaveError(e) !== 'network') setList({ error: 'The Due list couldn\'t be loaded.' })
        else if (last) setList({ rows: last.rows, at: last.at, live: false })
        else setList({ error: 'The Due list needs a connection the first time. It will show once you have signal.' })
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

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
      {!list.live && (
        <Notice title={`No connection. This is the list as it was ${new Date(list.at).toLocaleString()}.`}>
          It updates once you have signal.
        </Notice>
      )}

      {clients.length > 1 && (
        <label className="flex items-center gap-2 text-[13.5px]">
          <span className="text-ink-soft font-semibold">Client</span>
          <select
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            className="border-hair text-ink focus:border-navy rounded-lg border bg-white px-3 py-2 text-[14px] outline-none"
          >
            <option value="">All clients</option>
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
          Nothing overdue or due in the next 60 days, no site waiting on its first visit, and no
          alarm expiring in the next 3 months.
        </p>
      )}

      {groups.map(g => (
        <section key={g.kind} className="border-hair overflow-hidden rounded-xl border bg-white" aria-label={g.title}>
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
                  <span className="block text-[14px] font-semibold">{dueTitle(row)}</span>
                  <span className="text-ink-soft block text-[12.5px]">
                    {row.clientName} · {[row.address, row.suburb].filter(Boolean).join(', ')}
                  </span>
                </span>
                <span className="text-right text-[12.5px]">
                  <span className={`block font-semibold ${row.kind === 'overdue' ? 'text-fail' : 'text-ink'}`}>
                    {whenText(row)}
                  </span>
                  {lastDoneText(row) && <span className="text-ink-soft block">{lastDoneText(row)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
