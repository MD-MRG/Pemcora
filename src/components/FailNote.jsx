import { useState } from 'react'
import { fillTimeframe, holdsTimeframe } from '../lib/testTypes.js'

// The note a failed test takes. Where the test list has suggested wording
// (`failNotes`, such as an electrician's defect classifications), the box offers
// it: choosing one fills the note, which stays editable, and the one with
// [timeframe] asks for the timeframe first. Anything already typed is kept, under
// the wording chosen.
//
// `children` go above the box: what the test itself says about a fail, such as
// an alarm that has to be replaced.
export default function FailNote({ label, note, onChange, suggestions = [], placeholder, readOnly = false, children }) {
  const [asking, setAsking] = useState(null)
  const [timeframe, setTimeframe] = useState('')
  const [offering, setOffering] = useState(false)

  const fill = text => {
    const typed = String(note ?? '').trim()
    onChange(typed ? `${text}\n${typed}` : text)
  }
  const choose = text => {
    if (holdsTimeframe(text)) {
      setAsking(text)
      setTimeframe('')
    } else fill(text)
  }

  return (
    <div>
      <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">{label}</span>
      {children}

      {/* Offered while the note is empty, and on request after. */}
      {!readOnly && suggestions.length > 0 && (offering || !String(note ?? '').trim()) && (
        <div className="mb-2 flex flex-col gap-1.5" role="group" aria-label={`Suggested notes for ${label}`}>
          <span className="text-navy text-[11.5px] font-semibold tracking-[.06em] uppercase">Suggested wording</span>
          {suggestions.map((text, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setOffering(false)
                choose(text)
              }}
              className="border-navy/25 bg-navy/5 text-navy hover:bg-navy/10 rounded-lg border border-dashed px-3 py-2 text-left text-[12.5px]"
            >
              {text}
            </button>
          ))}
        </div>
      )}
      {!readOnly && suggestions.length > 0 && !offering && String(note ?? '').trim() !== '' && (
        <button
          type="button"
          onClick={() => setOffering(true)}
          className="text-navy mb-1.5 text-[12.5px] font-semibold hover:underline"
        >
          Suggested wording
        </button>
      )}

      {asking && (
        <div className="border-navy/20 bg-navy/5 mb-2 flex flex-wrap items-end gap-2 rounded-lg border p-3">
          <label className="min-w-0 flex-1">
            <span className="text-navy mb-1 block text-[12.5px] font-semibold">Within what timeframe?</span>
            <input
              autoFocus
              value={timeframe}
              onChange={e => setTimeframe(e.target.value)}
              placeholder="e.g. 3 months"
              aria-label="Timeframe"
              className="border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none"
            />
          </label>
          <button
            type="button"
            disabled={!timeframe.trim()}
            onClick={() => {
              fill(fillTimeframe(asking, timeframe))
              setAsking(null)
            }}
            className="bg-navy min-h-[40px] rounded-lg px-4 text-[13px] font-semibold text-white enabled:hover:bg-[#24486e] disabled:opacity-40"
          >
            Use
          </button>
          <button
            type="button"
            onClick={() => setAsking(null)}
            className="border-hair text-ink-soft min-h-[40px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      )}

      <textarea
        rows={2}
        value={note ?? ''}
        onChange={e => onChange(e.target.value)}
        readOnly={readOnly}
        aria-label={label}
        placeholder={placeholder}
        className="border-hair text-ink focus:border-navy w-full resize-y rounded-lg border px-3 py-2 text-[14px] outline-none"
      />
      {holdsTimeframe(note) && (
        <p className="text-fail mt-1 text-[12.5px]">
          Fill in the timeframe. The visit can&apos;t be finished while a note still says [timeframe].
        </p>
      )}
    </div>
  )
}
