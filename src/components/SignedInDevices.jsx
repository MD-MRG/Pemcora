import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog.jsx'
import { deviceName, thisDeviceFirst } from '../lib/devices.js'

// The devices signed in to your account, on the Account card (build plan C5):
// one row per login, "This device" on the one in use, and a way to sign any
// other out, for a phone that was lost or a laptop that was stolen.
//
// Presentational, so it can be put on the page without a real login behind it.
//
//   devices   [{ id, userAgent, signedInAt, lastUsedAt }]; null before 0010 is
//             applied, when only "Sign out all other devices" is possible;
//             undefined while loading
//   currentId this device's login, from its own token
//   offline   no connection: nothing can be signed out
//   onEnd(device), onEndOthers()   resolve when done, throw a message if not
export default function SignedInDevices({ devices, currentId, offline, loadError, onEnd, onEndOthers }) {
  const [asking, setAsking] = useState(null) // a device, or 'others'
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null) // { ok, text }

  const when = iso => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—')
  const others = (devices ?? []).filter(d => d.id !== currentId)

  const run = async (action, done) => {
    setBusy(true)
    setNote(null)
    try {
      await action()
      setNote({ ok: true, text: done })
    } catch (e) {
      setNote({ ok: false, text: e?.message ?? 'It didn\'t work. Try again.' })
    } finally {
      setBusy(false)
      setAsking(null)
    }
  }

  return (
    <div className="border-hair mt-6 border-t pt-5" role="region" aria-label="Signed-in devices">
      <h3 className="text-[15px] font-bold">Signed-in devices</h3>
      <p className="text-ink-soft mt-1 max-w-[62ch] text-[13.5px]">
        Every device signed in to your account. Sign out one you've lost, or that was stolen. It
        can't sign back in without your password, but it can keep working for up to an hour, until
        its current login runs out, and a device that never connects again keeps what it already
        holds.
      </p>

      {offline && <p className="text-ink-soft mt-3 text-[13.5px]">This needs a connection. It will show once you have signal.</p>}
      {!offline && devices === undefined && !loadError && <p className="text-ink-soft mt-3 text-[13.5px]">Loading…</p>}
      {!offline && loadError && <p className="text-ink-soft mt-3 text-[13.5px]">{loadError}</p>}
      {!offline && devices === null && (
        <p className="text-ink-soft mt-3 text-[13.5px]">
          The list of devices comes with an update. You can still sign out all your other devices.
        </p>
      )}

      {!offline && devices?.length > 0 && (
        <ul className="border-hair m-0 mt-3 list-none overflow-hidden rounded-lg border p-0">
          {thisDeviceFirst(devices, currentId).map(d => (
            <li
              key={d.id}
              className="border-hair flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3 last:border-0"
            >
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold">
                  {deviceName(d.userAgent)}
                  {d.id === currentId && (
                    <span className="bg-navy/10 text-navy ml-2 rounded-full px-2 py-0.5 text-[11.5px]">This device</span>
                  )}
                </span>
                <span className="text-ink-soft block text-[12.5px]">
                  Signed in {when(d.signedInAt)} · last used {when(d.lastUsedAt)}
                </span>
              </span>
              {d.id !== currentId && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setAsking(d)}
                  aria-label={`Sign out ${deviceName(d.userAgent)}, last used ${when(d.lastUsedAt)}`}
                  className="border-hair text-fail min-h-[38px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-red-50 disabled:opacity-50"
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!offline && (devices === null || others.length > 0) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setAsking('others')}
          className="border-hair text-ink mt-3 min-h-[42px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50 disabled:opacity-50"
        >
          Sign out all other devices
        </button>
      )}

      {note && (
        <p role={note.ok ? 'status' : 'alert'} className={`mt-2 text-[13px] font-semibold ${note.ok ? 'text-pass' : 'text-fail'}`}>
          {note.text}
        </p>
      )}

      {asking && asking !== 'others' && (
        <ConfirmDialog
          danger
          title={`Sign out ${deviceName(asking.userAgent)}?`}
          confirmLabel="Sign it out"
          cancelLabel="Keep it signed in"
          onCancel={() => setAsking(null)}
          onConfirm={() =>
            run(() => onEnd(asking), `${deviceName(asking.userAgent)} is signed out. It can't renew its login, which runs out within the hour.`)
          }
        >
          It was last used {when(asking.lastUsedAt)}. It will need your password to sign back in. Until
          its current login runs out, up to an hour, it can keep working. Work on it that hasn't been
          saved stays on it.
        </ConfirmDialog>
      )}

      {asking === 'others' && (
        <ConfirmDialog
          danger
          title="Sign out all your other devices?"
          confirmLabel="Sign them out"
          cancelLabel="Keep them signed in"
          onCancel={() => setAsking(null)}
          onConfirm={() =>
            run(onEndOthers, 'Your other devices are signed out. Their current logins run out within the hour.')
          }
        >
          Every device but this one will need your password to sign back in. This one stays signed in.
          Anyone mid-visit on another device should let it save first.
        </ConfirmDialog>
      )}
    </div>
  )
}
