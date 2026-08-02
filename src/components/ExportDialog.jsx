import { useState } from 'react'

// Asked only when a report has already been generated for this visit.
//
// Note on "Replace": the app never stores the file, so this cannot overwrite
// anything on disk. It keeps the revision number the same, so the download
// carries the identical filename and replaces the copy already sent.
export default function ExportDialog({ nextRev, currentRev, onChoose, onCancel }) {
  const [remember, setRemember] = useState(false)

  const choose = mode => onChoose({ mode, remember })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Export report"
      onClick={onCancel}
    >
      <div
        className="border-hair w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-bold">A report already exists for this visit</h2>
        <p className="text-ink-soft mt-1 text-[13.5px]">
          Replace the copy you already sent, or file this as a new revision so both can be told
          apart.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => choose('replace')}
            className="border-hair min-h-[52px] rounded-lg border px-4 text-left hover:bg-slate-50"
          >
            <span className="block text-[14px] font-semibold">Replace previous report</span>
            <span className="text-ink-soft block text-[12.5px]">
              Same filename as revision {currentRev} — overwrite the file you sent
            </span>
          </button>
          <button
            type="button"
            onClick={() => choose('revision')}
            className="border-navy/25 bg-navy/5 min-h-[52px] rounded-lg border px-4 text-left hover:bg-navy/10"
          >
            <span className="text-navy block text-[14px] font-semibold">
              Save as Revision {nextRev}
            </span>
            <span className="text-ink-soft block text-[12.5px]">
              Marked “Revision {nextRev}” in the filename and the report header
            </span>
          </button>
        </div>

        <label className="mt-4 flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            className="text-navy h-4.5 w-4.5 rounded"
          />
          <span className="text-[13px]">Remember this choice for this visit</span>
        </label>

        <button
          type="button"
          onClick={onCancel}
          className="text-ink-soft mt-4 w-full text-[13px] font-semibold"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
