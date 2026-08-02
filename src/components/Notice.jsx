// Inline banner for save outcomes. `blocked` is the stop-and-fix case; the
// default is informational — something happened and you should know, but the
// work continues.
export default function Notice({ blocked = false, title, children }) {
  const tone = blocked
    ? 'border-fail/30 bg-fail/5 text-[#8c2317]'
    : 'border-navy/20 bg-navy/5 text-navy'
  return (
    <div role="status" aria-live="polite" className={`rounded-lg border px-4 py-3 ${tone}`}>
      <p className="text-[13.5px] leading-snug font-semibold">{title}</p>
      {children && <div className="mt-2 text-[13px] text-ink-soft">{children}</div>}
    </div>
  )
}
