import ResultSelector from './ResultSelector.jsx'
import { measureResult, typeOf } from '../lib/testTypes.js'

// One test's answer, in the shape its type takes (src/lib/testTypes.js). Shared
// by a room's tests and the whole-site step, so a test reads the same wherever it
// is asked.
//
//   onAnswer(value, reading)   value is what results[group][testId] keeps;
//                              reading, for a measure, is readings[group][testId]
//
// Every button clears its answer when tapped again, as PASS / FAIL / N/A always
// has: blank and N/A mean different things.

const chip = (active, tone) =>
  `min-h-[44px] rounded-lg border-2 px-3 text-[12px] font-bold tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
    active ? tone : 'border-hair text-ink-soft bg-white enabled:hover:bg-slate-50'
  }`

const TONE = {
  pass: 'bg-pass border-pass text-white',
  fail: 'bg-fail border-fail text-white',
  na: 'bg-na border-na text-white',
  plain: 'bg-navy border-navy text-white',
}

function Buttons({ options, value, onChange, label, disabled }) {
  return (
    <div className="flex shrink-0 flex-wrap justify-end gap-1.5" role="group" aria-label={label}>
      {options.map(opt => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            aria-label={`${label}: ${opt.label}`}
            onClick={() => onChange(active ? null : opt.value)}
            className={`${chip(active, TONE[opt.tone])} min-w-[62px]`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

const YESNO = [
  { value: 'YES', label: 'Yes', tone: 'pass' },
  { value: 'NO', label: 'No', tone: 'fail' },
  { value: 'NA', label: 'N/A', tone: 'na' },
]

const inputCls =
  'border-hair text-ink focus:border-navy rounded-lg border bg-white px-3 py-2 text-[14px] outline-none read-only:bg-slate-50'

// A reading, its unit, and — when the test sets limits — the verdict they give.
function Measure({ test, value, reading, onAnswer, label, readOnly }) {
  const unit = reading?.unit ?? test.unit ?? ''
  const typed = reading?.value ?? ''
  const na = value === 'NA'
  const verdict = na ? null : measureResult(test, typed)
  const limits = [test.min != null && `min ${test.min}`, test.max != null && `max ${test.max}`].filter(Boolean).join(', ')

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      <label className="flex items-center gap-1.5">
        <input
          value={na ? '' : typed}
          onChange={e => {
            const next = e.target.value
            onAnswer(next.trim() ? measureResult(test, next) : null, next.trim() ? { value: next, unit } : null)
          }}
          readOnly={readOnly || na}
          inputMode="decimal"
          aria-label={`${label} reading`}
          placeholder={na ? 'N/A' : 'Reading'}
          className={`${inputCls} w-[110px] text-right tabular-nums`}
        />
        {unit && <span className="text-ink-soft min-w-[2ch] text-[13px] font-semibold">{unit}</span>}
      </label>
      {verdict && (
        <span
          className={`rounded-full px-2.5 py-1 text-[11.5px] font-bold ${verdict === 'FAIL' ? 'bg-fail/10 text-fail' : 'bg-green-100 text-pass'}`}
          title={limits}
        >
          {verdict}
        </span>
      )}
      <button
        type="button"
        disabled={readOnly}
        aria-pressed={na}
        aria-label={`${label}: N/A`}
        onClick={() => onAnswer(na ? null : 'NA', null)}
        className={`${chip(na, TONE.na)} min-w-[52px]`}
      >
        N/A
      </button>
    </div>
  )
}

export default function AnswerInput({ test, value, reading, onAnswer, label = test.label, readOnly = false }) {
  switch (typeOf(test)) {
    case 'yesno':
      return <Buttons options={YESNO} value={value} onChange={v => onAnswer(v)} label={label} disabled={readOnly} />
    case 'choice':
      return (
        <Buttons
          // An option that counts as a fail shows as one when chosen.
          options={(test.options ?? []).map(o => ({ value: o, label: o, tone: (test.failOptions ?? []).includes(o) ? 'fail' : 'plain' }))}
          value={value}
          onChange={v => onAnswer(v)}
          label={label}
          disabled={readOnly}
        />
      )
    case 'measure':
      return <Measure test={test} value={value} reading={reading} onAnswer={onAnswer} label={label} readOnly={readOnly} />
    case 'text':
      return (
        <input
          value={value ?? ''}
          onChange={e => onAnswer(e.target.value === '' ? null : e.target.value)}
          readOnly={readOnly}
          aria-label={label}
          placeholder="Type the answer"
          className={`${inputCls} w-full max-w-[280px]`}
        />
      )
    default:
      return <ResultSelector value={value ?? null} onChange={v => onAnswer(v)} label={label} disabled={readOnly} />
  }
}
