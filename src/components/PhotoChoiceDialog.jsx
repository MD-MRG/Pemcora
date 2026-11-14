// Which of the rooms' photos go in a PDF (M.D., room photos): all of them, none,
// or only one group. Asked each time a PDF is downloaded or sent, once the
// visit's rooms have photos. Each choice says how many photos it brings.

const option =
  'border-hair text-ink flex min-h-[46px] w-full items-center justify-between rounded-lg border bg-white px-4 text-left text-[14px] font-semibold hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40'

export default function PhotoChoiceDialog({ counts, sending = false, onChoose, onCancel }) {
  const choices = [
    ['all', 'All photos', counts.all],
    ['general', 'General only', counts.general],
    ['issue', 'Issues only', counts.issue],
    ['none', 'No photos', 0],
  ]
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Which photos go in the PDF?"
      onClick={onCancel}
    >
      <div className="border-hair w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h2 className="text-[16px] font-bold">Which photos go in the PDF?</h2>
        <p className="text-ink-soft mt-2 text-[13.5px]">
          The rooms have photos for this report: those added by the day the visit is completed.
          {sending ? ' The report is sent with the ones you choose.' : ''}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {choices.map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              disabled={id !== 'none' && n === 0}
              onClick={() => onChoose(id)}
              className={option}
            >
              <span>{label}</span>
              {id !== 'none' && <span className="text-ink-soft text-[13px] font-normal">{n}</span>}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="border-hair text-ink min-h-[46px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
