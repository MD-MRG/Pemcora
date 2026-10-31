import { useSyncExternalStore } from 'react'
import { heldCount, saveError, saveStatus, subscribe } from '../lib/cache.js'

// Where the work is, in the header on every page (build plan, step B3). Nothing
// else tells anyone whether a save reached the database, and a technician leaving
// site needs to know. Not shown when nothing is saved to a server at all.
const STATES = {
  saving: { label: 'Saving', tone: 'text-ink-soft' },
  saved: { label: 'Saved', tone: 'text-ink-soft' },
  offline: { label: 'Offline: changes are kept on this device', tone: 'text-amber-800' },
  failed: { label: 'Save failed', tone: 'text-fail' },
}

export default function SaveStatus() {
  const status = useSyncExternalStore(subscribe, saveStatus)
  const held = useSyncExternalStore(subscribe, heldCount)
  if (!status) return null

  const { label, tone } = STATES[status]
  const reason = status === 'failed' ? saveError()?.message : null

  return (
    <div role="status" aria-live="polite" className="max-w-[42vw] text-right sm:max-w-[320px]">
      <p className={`line-clamp-2 text-[12.5px] leading-tight font-semibold ${tone}`} title={reason ?? undefined}>
        {label}
        {reason && <span className="font-normal">: {reason}</span>}
      </p>
      {held > 0 && (
        <p className="text-fail mt-0.5 text-[12px] leading-tight font-semibold">
          {held} visit{held === 1 ? '' : 's'} not saved
        </p>
      )}
    </div>
  )
}
