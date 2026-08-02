// PASS / FAIL / N/A, sized for a gloved hand. Tapping the active value clears
// it back to blank — blank and N/A mean different things, and blanks export as
// empty rather than as "not applicable".
const OPTIONS = [
  { value: 'PASS', label: 'PASS', on: 'bg-pass border-pass text-white' },
  { value: 'FAIL', label: 'FAIL', on: 'bg-fail border-fail text-white' },
  { value: 'NA', label: 'N/A', on: 'bg-na border-na text-white' },
]

export default function ResultSelector({ value, onChange, label, disabled = false }) {
  return (
    <div className="flex shrink-0 gap-1.5" role="group" aria-label={label}>
      {OPTIONS.map(opt => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            aria-label={`${label}: ${opt.label}`}
            onClick={() => onChange(active ? null : opt.value)}
            className={`min-h-[44px] min-w-[62px] rounded-lg border-2 text-[12px] font-bold tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              active ? opt.on : 'border-hair text-ink-soft bg-white enabled:hover:bg-slate-50'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
