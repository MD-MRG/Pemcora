import { useEffect, useRef, useState } from 'react'

// A signature, drawn with a finger, a pen or a mouse, kept as one SVG path in a
// fixed 600 × 180 box (SIGNATURE_BOX). A path is a few kilobytes where a picture
// would be hundreds, so it lives in the visit's row on every plan, under the
// database's 50 KB limit (visits_signoff_check in 0007).
//
//   value     the path ('M10 20L12 22…'), or '' for none
//   onChange  called with the new path when a stroke ends, or '' on Clear

const SIGNATURE_BOX = { width: 600, height: 180 }

const round = n => Math.round(n * 10) / 10

export default function SignaturePad({ value, onChange, label = 'Signature', disabled = false }) {
  const svg = useRef(null)
  const [path, setPath] = useState(value ?? '')
  const drawn = useRef(value ?? '')
  const drawing = useRef(false)

  useEffect(() => {
    drawn.current = value ?? ''
    setPath(value ?? '')
  }, [value])

  const draw = next => {
    drawn.current = next
    setPath(next)
  }

  const point = e => {
    const box = svg.current.getBoundingClientRect()
    return [
      round(((e.clientX - box.left) / box.width) * SIGNATURE_BOX.width),
      round(((e.clientY - box.top) / box.height) * SIGNATURE_BOX.height),
    ]
  }

  const start = e => {
    if (disabled) return
    e.preventDefault()
    svg.current.setPointerCapture?.(e.pointerId)
    drawing.current = true
    const [x, y] = point(e)
    draw(`${drawn.current}M${x} ${y}`)
  }
  const move = e => {
    if (!drawing.current) return
    const [x, y] = point(e)
    draw(`${drawn.current}L${x} ${y}`)
  }
  const end = () => {
    if (!drawing.current) return
    drawing.current = false
    onChange(drawn.current)
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-ink-soft text-[12.5px] font-semibold">{label}</span>
        {!disabled && path && (
          <button
            type="button"
            onClick={() => {
              draw('')
              onChange('')
            }}
            className="text-navy text-[12.5px] font-semibold hover:underline"
          >
            Clear
          </button>
        )}
      </div>
      <svg
        ref={svg}
        role="img"
        aria-label={path ? `${label}, signed` : `${label}, sign here`}
        viewBox={`0 0 ${SIGNATURE_BOX.width} ${SIGNATURE_BOX.height}`}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        className="border-hair block h-[120px] w-full touch-none rounded-lg border bg-white sm:h-[150px]"
        style={{ cursor: disabled ? 'default' : 'crosshair' }}
      >
        <line x1="24" y1="140" x2="576" y2="140" stroke="#cbd5e1" strokeWidth="1.5" />
        {path ? (
          <path d={path} fill="none" stroke="#1b3a5c" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <text x="300" y="120" textAnchor="middle" fill="#94a3b8" fontSize="20">
            Sign here
          </text>
        )}
      </svg>
    </div>
  )
}
