import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import Notice from '../components/Notice.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import { listSentReports, resendReport, withdrawReport } from '../lib/api.js'
import { looksLikeEmail } from '../lib/sendReport.js'

// Sending a report from a finished visit (D2c): the address it goes to, what
// came of it, and the reports already sent, with "Send again" and "Withdraw".

const fmt = iso => (iso ? new Date(iso).toLocaleDateString() : '')

// The browser's own say on the connection, kept current while a dialog is open.
// The save status alone says nothing on a device that keeps its work locally.
const watchLine = notify => {
  window.addEventListener('online', notify)
  window.addEventListener('offline', notify)
  return () => {
    window.removeEventListener('online', notify)
    window.removeEventListener('offline', notify)
  }
}
const useNoSignal = () => useSyncExternalStore(watchLine, () => navigator.onLine === false)

/** Asks where the report goes. The client's contact email is filled in. */
export function SendDialog({ defaultEmail, offline: saysOffline, unsaved, onSend, onCancel }) {
  const [email, setEmail] = useState(defaultEmail ?? '')
  const offline = useNoSignal() || saysOffline
  const ready = looksLikeEmail(email) && !offline && !unsaved

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Send report"
      onClick={onCancel}
    >
      <form
        className="border-hair w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
        onSubmit={e => {
          e.preventDefault()
          if (ready) onSend(email.trim())
        }}
      >
        <h2 className="text-[16px] font-bold">Send this report</h2>
        <p className="text-ink-soft mt-1 text-[13.5px]">
          They get an email with a link to the PDF, which works for 90 days, and can save the report
          to a free Pemcora account. A sent report can&apos;t be changed: a correction goes as a new
          revision.
        </p>

        <label className="mt-4 block">
          <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">Send to</span>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="landlord@example.com"
            aria-label="Send to"
            autoFocus
            className="border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none"
          />
        </label>

        {offline && <p className="text-fail mt-3 text-[13px]">Sending a report needs a connection.</p>}
        {!offline && unsaved && (
          <p className="text-fail mt-3 text-[13px]">
            This device still has changes to save. Once they&apos;ve reached the database, the report
            can go.
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border-hair text-ink min-h-[46px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready}
            className="bg-navy min-h-[46px] rounded-lg px-5 text-[13.5px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send report
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * What came of a send or a "Send again": emailed, or the link to hand over when
 * nothing could be emailed. Never claims an email that didn't go.
 */
export function SentNotice({ sent, again = false }) {
  const [copied, setCopied] = useState(false)
  const lasts = sent.expiresAt ? `The link works until ${fmt(sent.expiresAt)}.` : 'The link works for 90 days.'
  return (
    <Notice title={sent.emailed ? `Report ${again ? 'sent again' : 'sent'} to ${sent.email}.` : `Report recorded for ${sent.email}, but not emailed.`}>
      <p>
        {sent.emailed
          ? `${lasts} Here it is too, in case they say the email never arrived.`
          : `No email could be sent from here. Send them this link yourself. ${lasts}`}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="border-hair min-w-0 flex-1 truncate rounded-md border bg-white px-2 py-1.5 font-mono text-[11.5px]">
          {sent.link}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(sent.link)
            setCopied(true)
          }}
          className="border-hair text-ink min-h-[38px] shrink-0 rounded-lg border bg-white px-3 text-[12.5px] font-semibold hover:bg-slate-50"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      {sent.photosMissing && (
        <p className="mt-2">
          The PDF went without some photos: they need a connection when it&apos;s made.
        </p>
      )}
    </Notice>
  )
}

function status(r, now) {
  if (r.savedAt) return `Saved by them ${fmt(r.savedAt)}`
  if (Date.parse(r.expiresAt) <= now) return 'Link expired'
  return `${r.openedAt ? `Opened ${fmt(r.openedAt)} · ` : ''}Link works until ${fmt(r.expiresAt)}`
}

/**
 * The reports sent from this visit. They're the database's, so the list needs a
 * connection. "Send again" sends a new link to the same address and switches the
 * old one off; "Withdraw" is there until the report is saved.
 */
export function SentReports({ visitId, title, offline: saysOffline, refreshKey }) {
  const offline = useNoSignal() || saysOffline
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)
  const [askWithdraw, setAskWithdraw] = useState(null)

  const load = useCallback(async () => {
    try {
      setRows(await listSentReports(visitId))
      setError('')
    } catch (e) {
      setError(e.message || 'The sent reports could not be loaded.')
    }
  }, [visitId])

  useEffect(() => {
    if (!offline) load()
  }, [load, offline, refreshKey])

  if (offline && !rows?.length) return null
  if (!error && !rows?.length && !note) return null

  const now = Date.now()
  const act = async (row, what) => {
    setBusy(row.id)
    setNote(null)
    try {
      if (what === 'resend') setNote({ sent: await resendReport(row.id, title) })
      else await withdrawReport(row.id)
      await load()
    } catch (e) {
      setNote({ error: e.message || 'That did not work.' })
    }
    setBusy(null)
  }

  return (
    <section className="border-hair mb-4 overflow-hidden rounded-xl border bg-white">
      <h3 className="border-hair text-ink-soft border-b bg-slate-50 px-4 py-2.5 text-[11.5px] font-semibold tracking-[.08em] uppercase">
        Sent
      </h3>
      {(note || error) && (
        <div className="border-hair border-b p-3">
          {note?.sent ? (
            <SentNotice sent={note.sent} again />
          ) : (
            <Notice blocked title={note?.error ?? error} />
          )}
        </div>
      )}
      {offline && <p className="text-ink-soft border-hair border-b px-4 py-2 text-[12.5px]">Send again and Withdraw need a connection.</p>}
      <ul className="m-0 list-none p-0">
        {(rows ?? []).map(r => (
          <li key={r.id} className="border-hair flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 last:border-0">
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-semibold">{r.email}</span>
              <span className="text-ink-soft block truncate text-[12px]">
                Sent {fmt(r.sentAt)} · {status(r, now)}
              </span>
            </span>
            <span className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={offline || busy !== null}
                onClick={() => act(r, 'resend')}
                aria-label={`Send again to ${r.email}`}
                className="border-hair text-navy min-h-[38px] rounded-lg border px-3 text-[13px] font-semibold enabled:hover:bg-slate-50 disabled:opacity-40"
              >
                {busy === r.id ? 'Working…' : 'Send again'}
              </button>
              {!r.savedAt && (
                <button
                  type="button"
                  disabled={offline || busy !== null}
                  onClick={() => setAskWithdraw(r)}
                  aria-label={`Withdraw the report sent to ${r.email}`}
                  className="border-hair text-fail min-h-[38px] rounded-lg border px-3 text-[13px] font-semibold enabled:hover:bg-red-50 disabled:opacity-40"
                >
                  Withdraw
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {askWithdraw && (
        <ConfirmDialog
          danger
          title={`Withdraw the report sent to ${askWithdraw.email}?`}
          confirmLabel="Withdraw"
          onCancel={() => setAskWithdraw(null)}
          onConfirm={() => {
            const row = askWithdraw
            setAskWithdraw(null)
            act(row, 'withdraw')
          }}
        >
          Its link stops working and they can no longer save it. An email already in their inbox
          stays there, but leads nowhere. It still counts towards today&apos;s sending limit.
        </ConfirmDialog>
      )}
    </section>
  )
}
