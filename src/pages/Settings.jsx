import { useOutletContext } from 'react-router-dom'
import { PLATE_LIST } from '../lib/plates.js'
import { BrandMark } from '../components/icons.jsx'

function PlateSwatch({ plate, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(plate.key)}
      aria-pressed={selected}
      className={`border-hair rounded-xl border-2 bg-white text-left transition-transform hover:-translate-y-px ${
        selected ? 'border-navy shadow-[0_0_0_3px_rgba(27,58,92,.15)]' : ''
      }`}
    >
      <div
        className="flex h-[66px] items-center gap-2.5 rounded-t-[10px] px-3.5"
        style={{ background: plate.bg, color: plate.fg }}
      >
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
          style={{ background: plate.mark, border: `1px solid ${plate.edge}` }}
        >
          <BrandMark size={17} />
        </span>
        <span className="min-w-0">
          <b className="block truncate text-[13px] leading-tight">Field Console</b>
          <span className="block text-[8.5px] tracking-[.15em] uppercase opacity-70">AV Service</span>
        </span>
      </div>
      <div className="px-3.5 py-2.5">
        <div className="flex items-baseline gap-2">
          <b className="text-[13.5px]">{plate.name}</b>
          <code className="text-ink-soft font-mono text-[11.5px]">{plate.hex}</code>
        </div>
        <p className="text-ink-soft mt-1 text-[12px] leading-snug">{plate.note}</p>
      </div>
    </button>
  )
}

export default function Settings() {
  const { plate, setPlate } = useOutletContext()

  return (
    <div className="mx-auto max-w-3xl p-6">
      <section className="border-hair rounded-xl border bg-white p-6">
        <h2 className="text-[20px] font-bold tracking-[-.01em]">Branding</h2>
        <p className="text-ink-soft mt-1 max-w-[62ch] text-[14.5px]">
          The plate sits top-left on every screen. Pick the background that suits your mark — text
          and icon contrast follow automatically.
        </p>

        <div className="mt-5 grid gap-3.5 sm:grid-cols-2">
          {PLATE_LIST.map(p => (
            <PlateSwatch key={p.key} plate={p} selected={plate === p.key} onSelect={setPlate} />
          ))}
        </div>

        <p className="text-ink-soft border-hair mt-6 border-t pt-4 text-[12.5px]">
          Saved on this device for now. It moves to your account when Settings is designed in full —
          along with logo upload, company details and the test-list editor.
        </p>
      </section>
    </div>
  )
}
