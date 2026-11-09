import { useState } from 'react'
import Notice from '../components/Notice.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import OpenPdf from '../components/OpenPdf.jsx'
import {
  addCertificate,
  addOwnCheck,
  photoUrl,
  recordCheckDone,
  removeOwnCheck,
} from '../lib/api.js'
import { classifySaveError } from '../lib/saveErrors.js'
import { CERTIFICATE_TYPES, certificateProblem } from '../lib/properties.js'

// A landlord's own checks at a property (build plan D4d): a gas check, a pool
// barrier, anything a report doesn't keep. A name, every how many months, and
// when it was last done (M.D.: Pemcora claims no legal intervals for these); the
// database works out when it's next due. On Pro, each can keep its certificate,
// a PDF or a photo (decision D6).

const input =
  'border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none'
const label = 'text-ink-soft mb-1 block text-[12.5px] font-semibold'
const small =
  'border-hair text-navy min-h-[34px] rounded-lg border bg-white px-2.5 text-[12.5px] font-semibold enabled:hover:bg-slate-50 disabled:opacity-40'

const today = () => new Date().toISOString().slice(0, 10)

// What a refusal says to a landlord.
function said(e, fallback) {
  if (navigator.onLine === false || classifySaveError(e) === 'network')
    return 'This needs a connection. Try again once you have signal.'
  if (/row-level security|403|Unauthorized/i.test(`${e?.message ?? ''} ${e?.statusCode ?? ''}`)) {
    return 'Keeping certificates here is part of Pro.'
  }
  return e?.message || fallback
}

export function AddCheck({ teamId, locationId, onDone, onCancel }) {
  const [d, setD] = useState({ label: '', months: '12', lastDone: '' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const months = Number(d.months)
  const ready =
    d.label.trim() &&
    Number.isInteger(months) &&
    months >= 1 &&
    months <= 120 &&
    d.lastDone &&
    d.lastDone <= today()

  return (
    <form
      className="border-hair mt-2 space-y-3 rounded-lg border p-3"
      aria-label="Add a check"
      onSubmit={async e => {
        e.preventDefault()
        if (!ready) return
        setBusy(true)
        setProblem('')
        try {
          await addOwnCheck(teamId, locationId, {
            label: d.label,
            intervalMonths: months,
            lastDoneOn: d.lastDone,
          })
          onDone()
        } catch (err) {
          setProblem(said(err, 'The check could not be added.'))
          setBusy(false)
        }
      }}
    >
      <label className="block">
        <span className={label}>What it is</span>
        <input
          value={d.label}
          onChange={e => setD({ ...d, label: e.target.value })}
          placeholder="Gas check"
          aria-label="What it is"
          className={input}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={label}>Every (months)</span>
          <input
            type="number"
            min="1"
            max="120"
            value={d.months}
            onChange={e => setD({ ...d, months: e.target.value })}
            aria-label="Every (months)"
            className={input}
          />
        </label>
        <label className="block">
          <span className={label}>Last done</span>
          <input
            type="date"
            max={today()}
            value={d.lastDone}
            onChange={e => setD({ ...d, lastDone: e.target.value })}
            aria-label="Last done"
            className={input}
          />
        </label>
      </div>
      <p className="text-ink-soft text-[12px]">
        How often it's needed is yours to say: check what applies to the property.
      </p>
      {problem && <Notice blocked title={problem} />}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!ready || busy}
          className="bg-navy min-h-[38px] rounded-lg px-3 text-[13px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:opacity-40"
        >
          {busy ? 'Adding…' : 'Add check'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border-hair text-ink-soft min-h-[38px] rounded-lg border px-3 text-[13px] font-semibold hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Done again, a certificate, or remove: for a check entered by hand. */
export function OwnCheckActions({ check, teamId, canKeepCertificates, onChanged }) {
  const [doneOn, setDoneOn] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [askRemove, setAskRemove] = useState(false)

  const run = async (work, fallback) => {
    setBusy(true)
    setProblem('')
    try {
      await work()
      onChanged()
    } catch (e) {
      setProblem(said(e, fallback))
    }
    setBusy(false)
  }

  return (
    <div className="mt-1 mb-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {doneOn === null ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setDoneOn(today())}
            className={small}
            aria-label={`Record ${check.label} as done`}
          >
            Done again
          </button>
        ) : (
          <>
            <input
              type="date"
              max={today()}
              value={doneOn}
              onChange={e => setDoneOn(e.target.value)}
              aria-label={`When ${check.label} was done`}
              className="border-hair rounded-lg border px-2 py-1 text-[12.5px]"
            />
            <button
              type="button"
              disabled={busy || !doneOn || doneOn > today()}
              onClick={() =>
                run(
                  () => recordCheckDone(check.id, doneOn).then(() => setDoneOn(null)),
                  'It wasn’t saved.',
                )
              }
              className={small}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setDoneOn(null)}
              className="text-ink-soft text-[12.5px] font-semibold"
            >
              Cancel
            </button>
          </>
        )}

        {check.hasCertificate && (
          <OpenPdf
            compact
            hasFile
            text="Certificate"
            label={`Open the certificate for ${check.label}`}
            getUrl={() => photoUrl(check.evidencePath)}
          />
        )}
        {canKeepCertificates ? (
          <label className={`${small} inline-flex cursor-pointer items-center`}>
            {check.hasCertificate ? 'Replace certificate' : 'Add certificate'}
            <input
              type="file"
              accept={CERTIFICATE_TYPES.join(',')}
              className="sr-only"
              aria-label={`Certificate for ${check.label}`}
              disabled={busy}
              onChange={e => {
                const file = e.target.files?.[0]
                e.target.value = ''
                const wrong = certificateProblem(file)
                if (wrong) return setProblem(wrong)
                run(
                  () => addCertificate(teamId, check.id, file, check.evidencePath),
                  'The certificate wasn’t kept.',
                )
              }}
            />
          </label>
        ) : (
          !check.hasCertificate && (
            <span className="text-ink-soft text-[12px]">
              Keeping its certificate here is part of Pro.
            </span>
          )
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => setAskRemove(true)}
          className="text-fail text-[12.5px] font-semibold"
        >
          Remove
        </button>
      </div>
      {problem && <Notice blocked title={problem} />}

      {askRemove && (
        <ConfirmDialog
          danger
          title={`Remove ${check.label}?`}
          confirmLabel="Remove"
          onCancel={() => setAskRemove(false)}
          onConfirm={() => {
            setAskRemove(false)
            run(() => removeOwnCheck(check.id, check.evidencePath), 'It wasn’t removed.')
          }}
        >
          It stops showing as due here and on the Due page
          {check.hasCertificate ? ', and its certificate goes with it' : ''}.
        </ConfirmDialog>
      )}
    </div>
  )
}
