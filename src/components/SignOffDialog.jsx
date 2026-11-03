import { useState } from 'react'
import SignaturePad from './SignaturePad.jsx'

// Signing off an inspection (build plan C1): the verdict, and who declares it.
//
// The outcome is the technician's declaration, not a count of fails: a fault
// fixed on the spot is a FAIL in the log and still a compliant property. The
// name, licence number and signature are kept with the visit (visits.signoff),
// so changing them in Settings later never rewrites a signed report. The
// database adds who was signed in and when it was saved.
//
//   signoff   the visit's sign-off so far, for a correction being signed again
//   onSign({ outcome, signoff })
export default function SignOffDialog({ title, outcome: wasOutcome, signoff: was, technician, licenceNumber, fails, onSign, onCancel }) {
  const [outcome, setOutcome] = useState(wasOutcome ?? null)
  const [name, setName] = useState(was?.technician ?? technician ?? '')
  const [licence, setLicence] = useState(was?.licence_number ?? licenceNumber ?? '')
  const [signature, setSignature] = useState(was?.signature ?? '')

  const ready = outcome && name.trim() && licence.trim() && signature

  const choice = (value, label, tone) => (
    <label
      className={`flex min-h-[46px] flex-1 cursor-pointer items-center gap-2 rounded-lg border-2 px-3 text-[13.5px] font-semibold ${
        outcome === value ? tone : 'border-hair text-ink'
      }`}
    >
      <input
        type="radio"
        name="outcome"
        value={value}
        checked={outcome === value}
        onChange={() => setOutcome(value)}
        className="h-4 w-4"
      />
      {label}
    </label>
  )

  const field = (label, value, onChange, placeholder) => (
    <label className="block">
      <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2.5 text-[14.5px] outline-none"
      />
    </label>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
    >
      <div className="border-hair w-full max-w-lg rounded-xl border bg-white p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h2 className="text-[16px] font-bold">{title}</h2>
        <p className="text-ink-soft mt-1 text-[13.5px]">
          Declare the outcome and sign. It goes on the report as it stands now.
        </p>

        <fieldset className="mt-4">
          <legend className="text-ink-soft mb-1.5 text-[12.5px] font-semibold">Outcome</legend>
          <div className="flex flex-wrap gap-2">
            {choice('compliant', 'Compliant', 'border-pass bg-green-50 text-pass')}
            {choice('non_compliant', 'Non-compliant', 'border-fail bg-red-50 text-fail')}
          </div>
          {fails > 0 && (
            <p className="text-ink-soft mt-1.5 text-[12.5px]">
              {fails} test{fails === 1 ? '' : 's'} failed. A fault fixed on the spot is still recorded
              as a fail, and the property can still be compliant.
            </p>
          )}
        </fieldset>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {field('Name', name, setName, 'Who carried out the inspection')}
          {field('Licence or registration number', licence, setLicence, 'e.g. A12345')}
        </div>

        <div className="mt-4">
          <SignaturePad value={signature} onChange={setSignature} />
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border-hair text-ink min-h-[46px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() =>
              onSign({
                outcome,
                signoff: {
                  technician: name.trim(),
                  licence_number: licence.trim(),
                  signed_at: new Date().toISOString(),
                  signature,
                },
              })
            }
            className="bg-navy min-h-[46px] rounded-lg px-5 text-[13.5px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Sign and finish
          </button>
        </div>
      </div>
    </div>
  )
}
