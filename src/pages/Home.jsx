import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listClients } from '../lib/clientStore.js'
import { stats, openWork, attention } from '../lib/home.js'

// Home answers three questions in the order a technician asks them:
//   1. what was I doing?          → open visits, with a way straight back in
//   2. what is waiting on me?     → the attention list
//   3. how are we tracking?       → the four figures
//
// The figures sit at the top because they are a glance, not a task; the work
// sits under them because that is what gets tapped.
//
// Deliberately NO "start something" launcher row. Every entry point it could
// offer is already in the Console Rail one column to the left, permanently and
// on every page — a second copy is furniture, not a shortcut.

const fmt = iso => (iso ? new Date(iso).toLocaleDateString() : '')

const ago = days => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`)

/* ── The four figures ─────────────────────────────────────────────────────────
   A KPI row, not a chart: four counts in three different units share no scale,
   so plotting them against one another would invent a comparison that does not
   exist. Proportional figures, not tabular — tabular-nums pads every digit to
   the width of a zero, which reads loose at this size. */
function Stat({ label, value }) {
  return (
    <div className="border-hair rounded-xl border bg-card p-4">
      <p className="text-ink-soft text-[12px] leading-tight font-semibold">{label}</p>
      <p className="text-navy mt-1.5 text-[30px] leading-none font-bold">{value}</p>
    </div>
  )
}

// Container query, not a `lg:` breakpoint: the stage is 196px narrower when the
// Console Rail is expanded, so a viewport-keyed breakpoint squeezes these four
// at exactly the widths where the nav is open. `@container` measures the space
// actually available and reflows the moment the rail does. Two fixed steps
// rather than auto-fit, because four tiles auto-fitting land on 3 + 1 at the
// in-between widths and the orphan reads as a mistake.
function StatRow({ figures }) {
  return (
    <section aria-label="Totals" className="@2xl:grid-cols-4 mb-6 grid grid-cols-2 gap-3">
      <Stat label="Clients" value={figures.clients} />
      <Stat label="Locations" value={figures.locations} />
      <Stat label="PM reports" value={figures.pmReports} />
      <Stat label="Commissioning reports" value={figures.commissioningReports} />
    </section>
  )
}

/* ── Section 1 · pick up where you left off ───────────────────────────────── */
function WorkRow({ row, onResume }) {
  return (
    <li className="border-hair border-b last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <p className="truncate text-[14.5px] font-semibold">
            {row.clientName}
            {row.where && <span className="text-ink-soft font-normal"> · {row.where}</span>}
          </p>
          <p className="text-ink-soft mt-0.5 text-[12.5px]">
            {row.kindLabel} · {row.done} of {row.total} room{row.total === 1 ? '' : 's'} complete ·
            started {ago(row.days)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {row.fails > 0 && (
            <span className="bg-fail/10 text-fail rounded-full px-2.5 py-1 text-[11.5px] font-semibold">
              {row.fails} FAIL{row.fails === 1 ? '' : 's'}
            </span>
          )}
          <button
            type="button"
            onClick={() => onResume(row)}
            className="bg-navy min-h-[42px] rounded-lg px-4 text-[13.5px] font-semibold text-white hover:bg-[#24486e]"
          >
            Resume
          </button>
        </div>
      </div>
    </li>
  )
}

/* ── Section 2 · needs attention ──────────────────────────────────────────── */
const ATTENTION = {
  unexported: {
    tag: 'Report not sent',
    line: row => `${row.kindLabel} finished ${fmt(row.at)} — no report exported`,
  },
  fails: {
    tag: 'FAILs without notes',
    line: row =>
      `${row.roomName} · ${row.count} FAIL${row.count === 1 ? '' : 's'} with nothing written against ${row.count === 1 ? 'it' : 'them'}`,
  },
  'no-rooms': {
    tag: 'No rooms recorded',
    line: () => 'This location has no floor plan yet, so no visit can be worked',
  },
}

function AttentionRow({ row, onGo }) {
  const spec = ATTENTION[row.type]
  return (
    <li className="border-hair border-b last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <p className="text-ink-soft text-[11px] font-semibold tracking-[.08em] uppercase">
            {spec.tag}
          </p>
          <p className="mt-1 truncate text-[14.5px] font-semibold">
            {row.clientName}
            {row.where && <span className="text-ink-soft font-normal"> · {row.where}</span>}
          </p>
          <p className="text-ink-soft mt-0.5 text-[12.5px]">{spec.line(row)}</p>
        </div>
        <button
          type="button"
          onClick={() => onGo(row)}
          className="border-hair text-navy min-h-[42px] shrink-0 rounded-lg border bg-white px-4 text-[13.5px] font-semibold hover:bg-slate-50"
        >
          {row.action}
        </button>
      </div>
    </li>
  )
}

function Panel({ title, count, children }) {
  return (
    <section className="mb-6">
      <h2 className="text-ink-soft mb-2 text-[11.5px] font-semibold tracking-[.08em] uppercase">
        {title}
        {count > 0 && <span className="text-ink-soft ml-2 normal-case">({count})</span>}
      </h2>
      <div className="border-hair overflow-hidden rounded-xl border bg-card">{children}</div>
    </section>
  )
}

const Quiet = ({ children }) => <p className="text-ink-soft px-4 py-5 text-[13.5px]">{children}</p>

/* ── Page ─────────────────────────────────────────────────────────────────── */
export default function Home() {
  const navigate = useNavigate()
  const clients = useMemo(() => listClients(), [])

  const figures = useMemo(() => stats(clients), [clients])
  const work = useMemo(() => openWork(clients), [clients])
  const flags = useMemo(() => attention(clients), [clients])

  // The deep-link. WorkflowPage and EditClient read this off the router state
  // and open on that location instead of the client list.
  const go = (path, row) =>
    navigate(path, {
      state: { clientId: row.clientId, locationId: row.locationId, roomId: row.roomId },
    })

  const onGo = row => go(row.type === 'no-rooms' ? '/edit-client' : row.path, row)

  // Nothing to summarise and nothing to resume — say what to do instead of
  // showing four zeros and three empty panels.
  if (clients.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <div className="border-hair rounded-xl border bg-card p-6">
          <h2 className="text-ink text-[16px] font-semibold">No clients yet</h2>
          <p className="text-ink-soft mt-2 text-[13.5px] leading-relaxed">
            Add your first client and its site, and this page fills in — what is in progress, what
            is waiting on a report, and how many jobs the team has behind it. Already have data on
            this device from an earlier version? Settings can import it.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link
              to="/new-client"
              className="bg-navy inline-flex min-h-[46px] items-center rounded-lg px-5 text-[13.5px] font-semibold text-white hover:bg-[#24486e]"
            >
              Add a client
            </Link>
            <Link
              to="/settings"
              className="border-hair text-ink inline-flex min-h-[46px] items-center rounded-lg border px-5 text-[13.5px] font-semibold hover:bg-slate-50"
            >
              Open Settings
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="@container mx-auto max-w-5xl p-4 sm:p-6">
      <StatRow figures={figures} />

      <Panel title="Pick up where you left off" count={work.length}>
        {work.length === 0 ? (
          <Quiet>Nothing in progress. Starting a visit from any workflow puts it here.</Quiet>
        ) : (
          <ul className="m-0 list-none p-0">
            {work.map(row => (
              <WorkRow key={row.key} row={row} onResume={r => go(r.path, r)} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Needs attention" count={flags.length}>
        {flags.length === 0 ? (
          <Quiet>All clear — every finished visit has a report and every FAIL has a note.</Quiet>
        ) : (
          <ul className="m-0 list-none p-0">
            {flags.map(row => (
              <AttentionRow key={row.key} row={row} onGo={onGo} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
