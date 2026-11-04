import { useEffect, useState, useSyncExternalStore } from 'react'
import { useCanManage, useEntitlements } from '../context/team.js'
import { entitledTeam, subscribeEntitlements } from '../lib/entitlements.js'
import { listWorkflowIntervals, setWorkflowInterval } from '../lib/api.js'
import { flush, saveStatus, subscribe } from '../lib/cache.js'
import { classifySaveError } from '../lib/saveErrors.js'
import { everyText, fallbackText, readMonths, recurringWorkflows } from '../lib/intervals.js'

// How often each recurring check is due (build plan 2.8, C3): the team's default
// in Settings (no clientId), or one client's own on Edit Client. Setting one
// moves the due dates of every site it covers, which the database works out, so
// it needs a connection and an owner or admin.
export default function IntervalSettings({ clientId = null }) {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const entitlements = useEntitlements()
  const canManage = useCanManage()
  const offline = useSyncExternalStore(subscribe, saveStatus) === 'offline'
  const workflows = recurringWorkflows(entitlements)
  const [chosen, setChosen] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [loaded, setLoaded] = useState(0)
  // Each row's last word, kept here: a row starts again from what's saved.
  const [notes, setNotes] = useState({})

  useEffect(() => {
    if (!teamId) return undefined
    let alive = true
    listWorkflowIntervals(teamId)
      .then(rows => alive && (setChosen(rows), setLoadError('')))
      .catch(e => {
        if (!alive) return
        setLoadError(
          classifySaveError(e) === 'network'
            ? 'These need a connection to show. They\'ll appear once you have signal.'
            : 'These couldn\'t be loaded.',
        )
      })
    return () => {
      alive = false
    }
  }, [teamId, loaded])

  if (!workflows.length) return null
  if (!teamId) {
    return <p className="text-ink-soft text-[13.5px]">Set once you're signed in to a team.</p>
  }
  if (loadError) return <p className="text-ink-soft text-[13.5px]">{loadError}</p>
  if (!chosen) return <p className="text-ink-soft text-[13.5px]">Loading…</p>

  const months = (workflowId, forClient) =>
    chosen.find(r => r.workflowId === workflowId && r.clientId === forClient)?.months ?? null

  return (
    <div className="flex flex-col gap-3">
      {!canManage && <p className="text-ink-soft text-[13px]">Only an owner or admin can change these.</p>}
      {workflows.map(w => (
        <IntervalRow
          // Starts again from what's saved whenever that changes.
          key={`${w.id}:${months(w.id, clientId)}`}
          workflow={w}
          own={months(w.id, clientId)}
          fallback={clientId ? fallbackText(w, months(w.id, null)) : fallbackText(w, null)}
          disabled={!canManage}
          offline={offline}
          note={notes[w.id] ?? null}
          setNote={note => setNotes(n => ({ ...n, [w.id]: note }))}
          onSave={async value => {
            // A client added offline has to reach the database before it can have
            // an interval of its own.
            if (clientId && !(await flush())) throw new Error('This client hasn\'t saved yet. Try again once it has.')
            await setWorkflowInterval(teamId, w.id, clientId, value)
            setLoaded(n => n + 1)
          }}
        />
      ))}
    </div>
  )
}

function IntervalRow({ workflow, own, fallback, disabled, offline, note, setNote, onSave }) {
  const [draft, setDraft] = useState(own == null ? '' : String(own))
  const [busy, setBusy] = useState(false)
  const name = workflow.nav.label

  if (workflow.interval.fixed) {
    return (
      <p className="text-[14px]">
        <span className="font-semibold">{name}</span>
        <span className="text-ink-soft"> — {everyText(workflow.interval.months)}, set by law</span>
      </p>
    )
  }

  const read = readMonths(draft)
  const changed = !read.error && read.months !== own
  const save = async () => {
    if (offline || navigator.onLine === false) return setNote({ ok: false, text: 'This needs a connection. Try again once you have signal.' })
    setBusy(true)
    setNote(null)
    try {
      await onSave(read.months)
      setNote({ ok: true, text: 'Saved. Due dates have moved to match.' })
    } catch (e) {
      setNote({
        ok: false,
        text: classifySaveError(e) === 'network' ? 'This needs a connection. Try again once you have signal.' : e?.message ?? 'It wasn\'t saved.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="min-w-[180px] font-semibold">{name}</span>
          <span className="text-ink-soft">every</span>
          <input
            value={draft}
            onChange={e => {
              setDraft(e.target.value)
              setNote(null)
            }}
            disabled={disabled || busy}
            inputMode="numeric"
            aria-label={`${name}: every how many months`}
            placeholder="—"
            className="border-hair text-ink focus:border-navy w-16 rounded-lg border bg-white px-2 py-1.5 text-center text-[14px] outline-none disabled:bg-slate-50"
          />
          <span className="text-ink-soft">months</span>
        </label>
        {!disabled && (
          <button
            type="button"
            onClick={save}
            disabled={!changed || busy}
            className="bg-navy min-h-[36px] rounded-lg px-3 text-[13px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
      <p className="text-ink-soft mt-1 text-[12.5px]">
        {read.error ? (
          <span className="text-fail font-semibold">{read.error}</span>
        ) : read.months == null ? (
          `Left blank: ${fallback}.`
        ) : null}
      </p>
      {note && (
        <p role={note.ok ? 'status' : 'alert'} className={`mt-1 text-[12.5px] font-semibold ${note.ok ? 'text-pass' : 'text-fail'}`}>
          {note.text}
        </p>
      )}
    </div>
  )
}
