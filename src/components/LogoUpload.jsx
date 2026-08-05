import { useRef, useState, useId } from 'react'
import { readLogoFile } from '../lib/logo.js'
import { BrandMark } from './icons.jsx'

export default function LogoUpload({ label, hint, logo, plate, square = false, onChange }) {
  const inputRef = useRef(null)
  const id = useId()
  const [error, setError] = useState('')

  const pick = async e => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked after a rejection
    if (!file) return
    const result = await readLogoFile(file)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError('')
    onChange(result.logo)
  }

  return (
    <div className="border-hair rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-bold">{label}</h3>
          <p className="text-ink-soft mt-0.5 text-[12.5px]">{hint}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="border-hair text-navy min-h-[40px] rounded-lg border px-3 text-[13px] font-semibold hover:bg-slate-50"
          >
            {logo ? 'Replace' : 'Upload'}
          </button>
          {logo && (
            <button
              type="button"
              onClick={() => {
                setError('')
                onChange(null)
              }}
              className="text-fail min-h-[40px] rounded-lg px-3 text-[13px] font-semibold hover:bg-red-50"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/svg+xml,image/png,image/jpeg"
        aria-label={label}
        onChange={pick}
        className="sr-only"
      />

      {/* Preview over the chosen plate colour — a dark logo vanishes on
          Espresso and a white one on Bone, and that must be visible here. */}
      <div
        className="mt-3 flex items-center rounded-lg px-3 py-2.5"
        style={{ background: plate.bg, color: plate.fg, minHeight: 60 }}
      >
        {logo ? (
          <img
            src={logo.src}
            alt={`${label} preview`}
            data-testid={square ? 'preview-collapsed' : 'preview-full'}
            className={square ? 'h-10 w-10 object-contain' : 'max-h-11 max-w-[180px] object-contain'}
          />
        ) : (
          <span
            className="grid h-10 w-10 place-items-center rounded-lg"
            style={{ background: plate.mark, border: `1px solid ${plate.edge}` }}
          >
            <BrandMark size={21} />
          </span>
        )}
      </div>

      {logo?.type === 'image/svg+xml' && !logo.reportSrc && (
        <p className="text-fail mt-2 text-[12.5px]">
          This SVG couldn’t be converted for Excel, so reports will show your company details as
          text. Upload a PNG if you want the logo on reports.
        </p>
      )}
      {error && <p className="text-fail mt-2 text-[12.5px]">{error}</p>}
    </div>
  )
}
