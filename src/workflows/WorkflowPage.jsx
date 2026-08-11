import { useState, useCallback, useMemo, useEffect } from 'react'
// Aliased: `location` already means the site being worked on throughout this file.
import { useLocation as useRouterLocation, useOutletContext } from 'react-router-dom'
import { useCanManage } from '../context/team.js'
import Field from '../components/Field.jsx'
import ResultSelector from '../components/ResultSelector.jsx'
import { BackBar, ClientsTable, LocationsTable } from '../components/ClientBrowser.jsx'
import { IconTrash } from '../components/icons.jsx'
import {
  listClients,
  listVisits,
  startVisit,
  completeVisit,
  roomsWithStatus,
  addRoomToLocation,
  getRoomEntry,
  saveRoomEntry,
  lastSectionToggles,
  deleteRoom,
  roomResultCount,
  deleteExport,
  reopenVisit,
} from '../lib/clientStore.js'
import { getTemplate } from '../lib/templateStore.js'
import { getSettings } from '../lib/settingsStore.js'
import { setVisitTechnician } from '../lib/clientStore.js'
import ExportDialog from '../components/ExportDialog.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import { downloadReport } from '../lib/report.js'
import { nextRevision, recordExport, setExportPreference } from '../lib/clientStore.js'

const fmt = iso => (iso ? new Date(iso).toLocaleDateString() : '')

const STATUS = {
  'not-started': { label: 'Not started', cls: 'bg-slate-100 text-ink-soft' },
  'in-progress': { label: 'In progress', cls: 'bg-amber-100 text-amber-800' },
  complete: { label: 'Complete', cls: 'bg-green-100 text-pass' },
}

function StatusChip({ status, fails }) {
  if (status === 'complete' && fails > 0) {
    return (
      <span className="bg-fail/10 text-fail rounded-full px-2.5 py-1 text-[11.5px] font-semibold">
        {fails} FAIL{fails === 1 ? '' : 's'}
      </span>
    )
  }
  const s = STATUS[status] ?? STATUS['not-started']
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${s.cls}`}>{s.label}</span>
  )
}

/* ── The visit state card — one place, one primary action ─────────────────── */
function VisitCard({ visit, roomCount, doneCount, config, canManage, onStart, onContinue, onFinish, onExport, onTechnician, onReopen }) {
  const open = visit && !visit.completedAt

  return (
    <section className="border-hair mb-4 rounded-xl border bg-white p-5 shadow-sm">
      {!visit ? (
        <>
          <h3 className="text-[15px] font-bold">{config.emptyLine}</h3>
          <p className="text-ink-soft mt-1 text-[13px]">
            Starting a visit records the date and tracks which rooms are done.
          </p>
        </>
      ) : open ? (
        <>
          <h3 className="text-[15px] font-bold">{config.progressNoun} in progress</h3>
          <p className="text-ink-soft mt-1 text-[13px] tabular-nums">
            Started {fmt(visit.startedAt)} · {doneCount} of {roomCount} rooms complete
          </p>
        </>
      ) : (
        <>
          <h3 className="text-[15px] font-bold">Last visit completed {fmt(visit.completedAt)}</h3>
          <p className="text-ink-soft mt-1 text-[13px]">
            {visit.exports?.length
              ? `${visit.exports.length} report(s) exported`
              : 'No report exported yet'}
          </p>
        </>
      )}

      {visit && (
        <label className="mt-4 block max-w-xs">
          <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">Technician</span>
          <input
            value={visit.technician ?? ''}
            onChange={e => onTechnician(e.target.value)}
            placeholder="Who attended"
            aria-label="Technician"
            className="border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none"
          />
        </label>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={open ? onContinue : onStart}
          className="bg-navy min-h-[46px] rounded-lg px-5 text-[14px] font-semibold text-white hover:bg-[#24486e]"
        >
          {open ? 'Continue' : visit ? config.newLabel : config.startLabel}
        </button>
        {open && (
          <button
            type="button"
            onClick={onFinish}
            className="border-hair text-ink min-h-[46px] rounded-lg border px-5 text-[14px] font-semibold hover:bg-slate-50"
          >
            Finish visit
          </button>
        )}
        {visit && (
          <button
            type="button"
            onClick={onExport}
            className="border-pass text-pass min-h-[46px] rounded-lg border-2 px-5 text-[14px] font-semibold hover:bg-green-50"
          >
            Export report
          </button>
        )}
        {/* Admin-only, and never on an already-open visit. Editing a finished
            visit means changing what a client's report was generated from, so
            it is a deliberate act rather than the default state. */}
        {visit && !open && canManage && (
          <button
            type="button"
            onClick={onReopen}
            className="border-hair text-ink min-h-[46px] rounded-lg border px-5 text-[14px] font-semibold hover:bg-slate-50"
          >
            Reopen for editing
          </button>
        )}
      </div>
    </section>
  )
}

/* ── Reports filed against a visit ────────────────────────────────────────── */
//
// Only the revision record is kept, never the file. Deleting one therefore
// removes the app's record that a report went out — it cannot reach a copy the
// client already has, which is worth saying plainly in the confirm.
function ReportList({ visit, canManage, onDelete }) {
  const reports = [...(visit.exports ?? [])].sort((a, b) => b.revision - a.revision)
  if (reports.length === 0) return null

  return (
    <section className="border-hair mb-4 overflow-hidden rounded-xl border bg-white">
      <h3 className="border-hair text-ink-soft border-b bg-slate-50 px-4 py-2.5 text-[11.5px] font-semibold tracking-[.08em] uppercase">
        Reports
      </h3>
      <ul className="m-0 list-none p-0">
        {reports.map(r => (
          <li
            key={r.revision}
            className="border-hair flex items-center justify-between gap-3 border-b px-4 py-3 last:border-0"
          >
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-semibold">
                Revision {r.revision}
              </span>
              <span className="text-ink-soft block truncate text-[12px]">
                {fmt(r.createdAt)}
                {r.filename ? ` · ${r.filename}` : ''}
              </span>
            </span>
            {canManage && (
              <button
                type="button"
                onClick={() => onDelete(r)}
                aria-label={`Delete revision ${r.revision}`}
                className="border-hair text-fail min-h-[38px] shrink-0 rounded-lg border px-3 text-[13px] font-semibold hover:bg-red-50"
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ── Add room — a floor is required, so the room lands in the right place ─── */
function AddRoomForm({ floors, onAdd, onCancel }) {
  const [floorId, setFloorId] = useState(floors[0]?.id ?? '__new')
  const [newFloorLabel, setNewFloorLabel] = useState('')
  const [name, setName] = useState('')
  const [planNumber, setPlanNumber] = useState('')

  const creatingFloor = floorId === '__new'
  const ready = name.trim() && (!creatingFloor || newFloorLabel.trim())

  return (
    <section className="border-hair mb-4 rounded-xl border bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-[15px] font-bold">Add room</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">
            Floor <span className="text-fail">*</span>
          </span>
          <select
            value={floorId}
            onChange={e => setFloorId(e.target.value)}
            aria-label="Floor"
            className="border-hair text-ink focus:border-navy min-h-[44px] w-full rounded-lg border bg-white px-3 text-[14.5px] outline-none"
          >
            {floors.map(f => (
              <option key={f.id} value={f.id}>
                {f.label || 'Unnamed floor'}
              </option>
            ))}
            <option value="__new">+ New floor…</option>
          </select>
        </label>

        {creatingFloor && (
          <Field
            label="New floor name"
            required
            value={newFloorLabel}
            onChange={setNewFloorLabel}
            placeholder="e.g. Level 47"
            className="sm:col-span-2"
          />
        )}

        <Field
          label="Room name"
          required
          value={name}
          onChange={setName}
          placeholder="e.g. Boardroom"
        />
        <Field
          label="Floor plan no."
          value={planNumber}
          onChange={setPlanNumber}
          placeholder="Plan number"
        />
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() =>
            onAdd({ floorId: creatingFloor ? null : floorId, newFloorLabel, name, planNumber })
          }
          className="bg-navy min-h-[44px] rounded-lg px-5 text-[13.5px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add room
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border-hair text-ink-soft min-h-[44px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </section>
  )
}

/* ── Level 3 · visit overview ─────────────────────────────────────────────── */
function VisitLevel({ client, location, config, canManage, onBack, onOpenRoom, onChanged }) {
  const [adding, setAdding] = useState(false)
  const [askExport, setAskExport] = useState(false)
  const [askFinish, setAskFinish] = useState(false)
  const [askDeleteRoom, setAskDeleteRoom] = useState(null)
  const [askDeleteReport, setAskDeleteReport] = useState(null)
  const [askReopen, setAskReopen] = useState(false)
  const [reopenError, setReopenError] = useState('')

  const visits = listVisits(client.id, location.id, config.kind)
  const current = visits.find(v => !v.completedAt) ?? visits[0] ?? null
  // Statuses come from the most recent visit whether it is open or finished —
  // before a new visit starts, the list should still show what the last one
  // found rather than pretending nothing has been tested.
  const rooms = roomsWithStatus(client.id, location.id, current)
  const done = rooms.filter(r => r.status === 'complete').length

  // Group rooms under their floor, preserving floor order.
  const grouped = useMemo(() => {
    const map = new Map()
    for (const r of rooms) {
      if (!map.has(r.floorId)) map.set(r.floorId, { label: r.floorLabel, rooms: [] })
      map.get(r.floorId).rooms.push(r)
    }
    return [...map.entries()]
  }, [rooms])

  const runExport = async (mode, remember = false) => {
    if (!current) return
    const revision =
      (current.exports ?? []).length === 0
        ? 1
        : mode === 'replace'
          ? nextRevision(current) - 1
          : nextRevision(current)
    const filename = await downloadReport({
      client, location, visit: current, rooms, revision, reportTitle: config.reportTitle,
      settings: getSettings(),
    })
    recordExport(client.id, location.id, current.id, { mode, filename })
    if (remember) setExportPreference(client.id, location.id, current.id, mode)
    setAskExport(false)
    onChanged()
  }

  const floors = (location.floors ?? []).map(f => ({ id: f.id, label: f.label }))

  return (
    <>
      <BackBar
        title={`${config.title} — ${client.name}`}
        subtitle={[location.address, location.suburb].filter(Boolean).join(', ')}
        onBack={onBack}
      />

      <VisitCard
        config={config}
        visit={current}
        roomCount={rooms.length}
        doneCount={done}
        onStart={() => {
          startVisit(client.id, location.id, config.kind, getSettings().technician ?? '')
          onChanged()
        }}
        onContinue={() => {
          const first = rooms.find(r => r.status !== 'complete') ?? rooms[0]
          if (first) onOpenRoom(first.id)
        }}
        onExport={() => {
          if (!current) return
          const already = (current.exports ?? []).length > 0
          // Only ask once a report exists, and skip the prompt if the
          // technician chose to remember an answer for this visit.
          if (already && !current.exportPreference) setAskExport(true)
          else runExport(current.exportPreference ?? 'revision')
        }}
        onTechnician={value => {
          if (!current) return
          setVisitTechnician(client.id, location.id, current.id, value)
          onChanged()
        }}
        onFinish={() => setAskFinish(true)}
        canManage={canManage}
        onReopen={() => {
          setReopenError('')
          setAskReopen(true)
        }}
      />

      {reopenError && (
        <p className="border-fail/30 bg-fail/5 text-fail mb-4 rounded-lg border px-4 py-3 text-[13.5px]">
          {reopenError}
        </p>
      )}

      {current && (
        <ReportList visit={current} canManage={canManage} onDelete={r => setAskDeleteReport(r)} />
      )}

      {adding ? (
        <AddRoomForm
          floors={floors}
          onCancel={() => setAdding(false)}
          onAdd={payload => {
            addRoomToLocation(client.id, location.id, payload)
            setAdding(false)
            onChanged()
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="border-hair text-navy mb-4 min-h-[46px] w-full rounded-lg border border-dashed px-4 text-[13.5px] font-semibold hover:bg-slate-50"
        >
          + Add room
        </button>
      )}

      {rooms.length === 0 ? (
        <p className="text-ink-soft text-[14px]">
          No rooms recorded for this location yet — add them as you work through the site.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map(([floorId, group]) => (
            <section
              key={floorId}
              className="border-hair overflow-hidden rounded-xl border bg-white"
            >
              <h3 className="border-hair text-ink-soft border-b bg-slate-50 px-4 py-2.5 text-[11.5px] font-semibold tracking-[.08em] uppercase">
                {group.label || 'Unnamed floor'}
              </h3>
              {/* The delete control is a SIBLING of the open button, not nested
                  inside it — a button within a button is invalid HTML and the
                  inner click gets swallowed. */}
              <ul className="m-0 list-none p-0">
                {group.rooms.map(room => (
                  <li
                    key={room.id}
                    className="border-hair flex items-center border-b pr-2 last:border-0 hover:bg-slate-50"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRoom(room.id)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3 text-left"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold">
                          {room.name || 'Unnamed room'}
                        </span>
                        {room.planNumber && (
                          <span className="text-ink-soft block text-[12px]">
                            Plan {room.planNumber}
                          </span>
                        )}
                      </span>
                      <StatusChip status={room.status} fails={room.fails} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setAskDeleteRoom(room)}
                      aria-label={`Delete ${room.name || 'Unnamed room'}`}
                      className="text-ink-soft hover:text-fail ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg hover:bg-red-50"
                    >
                      <IconTrash size={18} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {askFinish && current && (
        <ConfirmDialog
          title="Finish this visit?"
          confirmLabel="Finish visit"
          onCancel={() => setAskFinish(false)}
          onConfirm={() => {
            completeVisit(client.id, location.id, current.id)
            setAskFinish(false)
            onChanged()
          }}
        >
          It moves into history and a new visit can be started. Results are kept.
        </ConfirmDialog>
      )}

      {askDeleteRoom && (
        <ConfirmDialog
          danger
          title={`Delete "${askDeleteRoom.name || 'Unnamed room'}"?`}
          confirmLabel="Delete room"
          onCancel={() => setAskDeleteRoom(null)}
          onConfirm={() => {
            deleteRoom(client.id, location.id, askDeleteRoom.id)
            setAskDeleteRoom(null)
            onChanged()
          }}
        >
          It is removed from this location's floor plan, here and on Edit Client.
          {roomResultCount(client.id, location.id, askDeleteRoom.id) > 0 && (
            <>
              {' '}
              <b>
                {roomResultCount(client.id, location.id, askDeleteRoom.id)} visit(s) recorded results
                for this room.
              </b>{' '}
              Those results are kept, but the room will no longer appear on a report regenerated
              from them.
            </>
          )}
        </ConfirmDialog>
      )}

      {askDeleteReport && current && (
        <ConfirmDialog
          danger
          title={`Delete the record of revision ${askDeleteReport.revision}?`}
          confirmLabel="Delete record"
          onCancel={() => setAskDeleteReport(null)}
          onConfirm={() => {
            deleteExport(client.id, location.id, current.id, askDeleteReport.revision)
            setAskDeleteReport(null)
            onChanged()
          }}
        >
          The spreadsheet itself was never stored here, so this removes the record that it went out
          — not any copy the client already holds. The visit keeps everything needed to generate the
          report again.
        </ConfirmDialog>
      )}

      {askReopen && current && (
        <ConfirmDialog
          title="Reopen this visit for editing?"
          confirmLabel="Reopen"
          onCancel={() => setAskReopen(false)}
          onConfirm={() => {
            const outcome = reopenVisit(client.id, location.id, current.id)
            setAskReopen(false)
            if (outcome === 'conflict') {
              setReopenError(
                'Another visit of this type is already open at this location. Finish that one first — two open visits would overwrite each other.',
              )
              return
            }
            onChanged()
          }}
        >
          It becomes editable again and counts as in progress. A report has already been generated
          from it, so anything you change here will differ from the copy the client holds until you
          export a new revision.
        </ConfirmDialog>
      )}

      {askExport && current && (
        <ExportDialog
          nextRev={nextRevision(current)}
          currentRev={nextRevision(current) - 1}
          onCancel={() => setAskExport(false)}
          onChoose={({ mode, remember }) => runExport(mode, remember)}
        />
      )}

      {visits.length > 1 && (
        <section className="mt-6">
          <h3 className="text-ink-soft mb-2 text-[11.5px] font-semibold tracking-[.08em] uppercase">
            Past visits
          </h3>
          <ul className="border-hair m-0 list-none overflow-hidden rounded-xl border bg-white p-0">
            {visits
              .filter(v => v.id !== current?.id)
              .map(v => (
                <li
                  key={v.id}
                  className="border-hair text-ink-soft border-b px-4 py-2.5 text-[13px] last:border-0"
                >
                  {v.completedAt ? `Completed ${fmt(v.completedAt)}` : `Started ${fmt(v.startedAt)}`}
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  )
}

/* ── Level 4 · room tests ─────────────────────────────────────────────────── */
function TestRow({ test, value, onChange, readOnly }) {
  return (
    <div className="border-hair flex items-center justify-between gap-4 border-b px-4 py-2.5 last:border-0">
      <span className="min-w-0 text-[14px] font-medium">{test.label}</span>
      <ResultSelector value={value ?? null} onChange={onChange} label={test.label} disabled={readOnly} />
    </div>
  )
}

function RoomLevel({ client, location, visit, roomId, rooms, readOnly, config, canManage, onBack, onOpenRoom, onChanged, onReopen }) {
  const index = rooms.findIndex(r => r.id === roomId)
  const room = rooms[index]
  const { setDetail } = useOutletContext()

  // Put the room's name in the app header, and take it away again on the way
  // out — the cleanup is what stops a room name sitting over Settings.
  useEffect(() => {
    setDetail(room ? [room.name || 'Unnamed room', room.floorLabel].filter(Boolean).join(' · ') : null)
    return () => setDetail(null)
  }, [room, setDetail])

  const template = useMemo(() => getTemplate(config.templateKind), [config.templateKind])
  const stored = visit ? getRoomEntry(client.id, location.id, visit.id, roomId) : null

  // Snapshot the template the first time a room is opened, so later edits to
  // the lists never alter a room that has already been filled in.
  const snapshot = stored?.template ?? template

  const [results, setResults] = useState(() => stored?.results ?? { main: {} })
  const [sections, setSections] = useState(
    () =>
      stored?.sections ??
      (visit ? lastSectionToggles(client.id, location.id, visit.id) : null) ??
      Object.fromEntries(snapshot.sections.map(s => [s.id, false])),
  )
  const [troubleshooting, setTroubleshooting] = useState(() => stored?.troubleshooting ?? {})
  const [comments, setComments] = useState(() => stored?.comments ?? '')
  const [complete, setComplete] = useState(() => stored?.status === 'complete')
  const [pending, setPending] = useState(null)

  const labelFor = useCallback(
    testId =>
      [...snapshot.tests, ...snapshot.sections.flatMap(s => s.tests)].find(t => t.id === testId)
        ?.label ?? 'this test',
    [snapshot],
  )

  // Persist on every change — a technician walking away must not lose a room.
  const persist = useCallback(
    patch => {
      if (readOnly || !visit) return
      saveRoomEntry(client.id, location.id, visit.id, roomId, {
        results,
        sections,
        troubleshooting,
        comments,
        template: snapshot,
        status: complete ? 'complete' : undefined,
        ...patch,
      })
      onChanged()
    },
    [client.id, location.id, visit, roomId, results, sections, troubleshooting, comments, snapshot, complete, onChanged, readOnly],
  )

  const applyResult = (groupId, testId, value) => {
    const was = results[groupId]?.[testId]
    const nextResults = { ...results, [groupId]: { ...(results[groupId] ?? {}), [testId]: value } }
    let nextNotes = troubleshooting
    if (was === 'FAIL' && value !== 'FAIL' && testId in troubleshooting) {
      nextNotes = { ...troubleshooting }
      delete nextNotes[testId]
    }
    setResults(nextResults)
    setTroubleshooting(nextNotes)
    persist({ results: nextResults, troubleshooting: nextNotes })
  }

  const setResult = (groupId, testId, value) => {
    if (readOnly) return
    const was = results[groupId]?.[testId]
    const note = troubleshooting[testId]
    // Leaving FAIL discards the note it generated — confirm first (v1 §8.2).
    if (was === 'FAIL' && value !== 'FAIL' && note && note.trim()) {
      setPending({ groupId, testId, value, label: labelFor(testId) })
      return
    }
    applyResult(groupId, testId, value)
  }

  const toggleSection = (sectionId, on) => {
    if (readOnly) return
    const next = { ...sections, [sectionId]: on }
    setSections(next)
    persist({ sections: next })
  }

  const setNote = (testId, text) => {
    if (readOnly) return
    const next = { ...troubleshooting, [testId]: text }
    setTroubleshooting(next)
    persist({ troubleshooting: next })
  }

  // FAILs from visible groups only — a switched-off section keeps its results
  // but must not raise troubleshooting rows.
  const failed = [
    ...snapshot.tests.filter(t => results.main?.[t.id] === 'FAIL'),
    ...snapshot.sections
      .filter(s => sections[s.id])
      .flatMap(s => s.tests.filter(t => results[s.id]?.[t.id] === 'FAIL')),
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <BackBar
          title={room?.name || 'Room'}
          subtitle={`${client.name} · ${room?.floorLabel || 'Unnamed floor'}`}
          onBack={onBack}
        />

        {readOnly && (
          <div className="border-navy/20 bg-navy/5 text-navy mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-[13.5px]">
            <span>
              {visit
                ? 'This visit is finished — showing what it recorded. Start a new visit to make changes.'
                : 'No visit has been started for this location yet. Start one to record results.'}
            </span>
            {/* The wall is hit here, so the way through it belongs here too. */}
            {visit && canManage && (
              <button
                type="button"
                onClick={onReopen}
                className="border-navy/30 text-navy min-h-[38px] shrink-0 rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50"
              >
                Reopen for editing
              </button>
            )}
          </div>
        )}

        <section className="border-hair mb-4 overflow-hidden rounded-xl border bg-white">
          <h3 className="border-hair text-ink-soft border-b bg-slate-50 px-4 py-2.5 text-[11.5px] font-semibold tracking-[.08em] uppercase">
            {snapshot.mainLabel}
          </h3>
          {snapshot.tests.map(t => (
            <TestRow
              key={t.id}
              test={t}
              value={results.main?.[t.id]}
              onChange={v => setResult('main', t.id, v)}
              readOnly={readOnly}
            />
          ))}
        </section>

        {snapshot.sections.map(section => (
          <section key={section.id} className="border-hair mb-4 overflow-hidden rounded-xl border bg-white">
            <label className="border-hair flex cursor-pointer items-center gap-3 border-b bg-slate-50 px-4 py-3">
              <input
                type="checkbox"
                checked={!!sections[section.id]}
                onChange={e => toggleSection(section.id, e.target.checked)}
                disabled={readOnly}
                className="text-navy h-5 w-5 rounded disabled:opacity-60"
              />
              <span className="text-[13.5px] font-semibold">{section.label}</span>
            </label>
            {sections[section.id] &&
              section.tests.map(t => (
                <TestRow
                  key={t.id}
                  test={t}
                  value={results[section.id]?.[t.id]}
                  onChange={v => setResult(section.id, t.id, v)}
                  readOnly={readOnly}
                />
              ))}
          </section>
        ))}

        <section className="border-hair mb-4 rounded-xl border bg-white p-4">
          <h3 className="mb-3 text-[14px] font-bold">Troubleshooting</h3>
          {failed.length === 0 ? (
            <p className="text-ink-soft text-[13.5px]">No issues identified.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {failed.map(t => (
                <label key={t.id} className="block">
                  <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">
                    {t.label}
                  </span>
                  <textarea
                    rows={2}
                    value={troubleshooting[t.id] ?? ''}
                    onChange={e => setNote(t.id, e.target.value)}
                    readOnly={readOnly}
                    placeholder="Describe the issue / action taken"
                    className="border-hair text-ink focus:border-navy w-full resize-y rounded-lg border px-3 py-2 text-[14px] outline-none"
                  />
                </label>
              ))}
            </div>
          )}
        </section>

        <section className="border-hair mb-4 rounded-xl border bg-white p-4">
          <h3 className="mb-3 text-[14px] font-bold">Comments</h3>
          <textarea
            rows={3}
            value={comments}
            onChange={e => setComments(e.target.value)}
            onBlur={() => !readOnly && persist({ comments })}
            readOnly={readOnly}
            placeholder="Any general notes for this room"
            className="border-hair text-ink focus:border-navy w-full resize-y rounded-lg border px-3 py-2 text-[14px] outline-none"
          />
        </section>

        {!readOnly && (
        <button
          type="button"
          onClick={() => {
            const next = !complete
            setComplete(next)
            persist({ status: next ? 'complete' : 'in-progress' })
            // Marking a room done moves straight on to the next one — that is
            // the actual rhythm of a site walk. Only on the way TO complete:
            // un-ticking a room means you want to stay and fix something.
            // The last room has nowhere to advance to, so it returns to the
            // list, which is also where Export lives.
            if (!next) return
            const following = rooms[index + 1]
            if (following) onOpenRoom(following.id)
            else onBack()
          }}
          className={`mb-4 min-h-[48px] w-full rounded-lg border-2 text-[14px] font-semibold transition-colors ${
            complete ? 'bg-pass border-pass text-white' : 'border-pass text-pass bg-white hover:bg-green-50'
          }`}
        >
          {complete ? 'Room complete ✓' : 'Mark room complete'}
        </button>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          danger
          title={`Discard troubleshooting notes for "${pending.label}"?`}
          confirmLabel="Discard notes"
          cancelLabel="Keep the note"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            applyResult(pending.groupId, pending.testId, pending.value)
            setPending(null)
          }}
        >
          Changing the result away from FAIL removes the notes you typed for it.
        </ConfirmDialog>
      )}

      <footer className="border-hair mt-2 grid shrink-0 grid-cols-3 gap-2 border-t-2 bg-white py-3">
        <button
          type="button"
          disabled={index <= 0}
          onClick={() => onOpenRoom(rooms[index - 1].id)}
          className="border-hair text-ink min-h-[48px] rounded-lg border bg-white text-[13.5px] font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={onBack}
          className="border-hair text-ink min-h-[48px] rounded-lg border bg-white text-[13.5px] font-semibold hover:bg-slate-50"
        >
          List
        </button>
        <button
          type="button"
          disabled={index >= rooms.length - 1}
          onClick={() => onOpenRoom(rooms[index + 1].id)}
          className="bg-navy min-h-[48px] rounded-lg text-[13.5px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next →
        </button>
      </footer>
    </div>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function WorkflowPage({ config }) {
  // Home deep-links straight to a location, and sometimes to a room. Every
  // other way in — the side nav, a hard reload — carries no router state, so
  // these fall back to null and the page opens on the client list exactly as
  // it always has. A room that no longer exists is already handled below.
  const from = useRouterLocation().state ?? {}

  const [clients, setClients] = useState(() => listClients())
  const [clientId, setClientId] = useState(from.clientId ?? null)
  const [locationId, setLocationId] = useState(from.locationId ?? null)
  const [roomId, setRoomId] = useState(from.roomId ?? null)
  const canManage = useCanManage()

  const refresh = useCallback(() => setClients(listClients()), [])
  const client = clients.find(c => c.id === clientId) ?? null
  const location = client?.locations.find(l => l.id === locationId) ?? null

  if (!client) {
    return (
      <div className="p-4 sm:p-6">
        <ClientsTable clients={clients} onOpen={setClientId} />
      </div>
    )
  }

  if (!location) {
    return (
      <div className="p-4 sm:p-6">
        <LocationsTable
          client={client}
          onBack={() => {
            setClientId(null)
            refresh()
          }}
          onOpen={setLocationId}
        />
      </div>
    )
  }

  if (roomId) {
    const visits = listVisits(client.id, location.id, config.kind)
    // Results can only be recorded into an OPEN visit. With none open the room
    // still opens, showing the last visit's findings read-only — tapping a room
    // to review must never silently start a visit and blank every chip.
    const visit = visits.find(v => !v.completedAt) ?? visits[0] ?? null
    const readOnly = !visit || !!visit.completedAt
    const rooms = roomsWithStatus(client.id, location.id, visit)
    if (!rooms.some(r => r.id === roomId)) {
      setRoomId(null)
      return null
    }
    return (
      <div className="flex h-full flex-col p-4 sm:p-6">
        <RoomLevel
          key={roomId}
          client={client}
          location={location}
          visit={visit}
          roomId={roomId}
          rooms={rooms}
          readOnly={readOnly}
          config={config}
          canManage={canManage}
          onReopen={() => {
            // Cannot conflict from here: an open visit would have been the one
            // selected above, so reaching this branch means there is none.
            if (visit) reopenVisit(client.id, location.id, visit.id)
            refresh()
          }}
          onOpenRoom={setRoomId}
          onBack={() => {
            setRoomId(null)
            refresh()
          }}
          onChanged={refresh}
        />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6">
      <VisitLevel
        client={client}
        location={location}
        config={config}
        canManage={canManage}
        onBack={() => {
          setLocationId(null)
          refresh()
        }}
        onOpenRoom={setRoomId}
        onChanged={refresh}
      />
    </div>
  )
}
