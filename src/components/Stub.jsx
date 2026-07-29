// Placeholder page body. Each stub states what will live here, so the shell
// doubles as a spec while the individual pages are designed.
export default function Stub({ title, summary, points = [], step }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="border-hair rounded-xl border bg-white p-6">
        <h2 className="text-[20px] font-bold tracking-[-.01em]">{title}</h2>
        <p className="text-ink-soft mt-1 max-w-[62ch] text-[14.5px]">{summary}</p>

        {points.length > 0 && (
          <ul className="mt-5 flex list-none flex-col gap-2.5 p-0">
            {points.map(p => (
              <li key={p} className="flex items-start gap-3 text-[14px]">
                <span className="bg-brass mt-[7px] block h-2 w-2 shrink-0 rounded-full" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        )}

        {step && (
          <p className="text-ink-soft border-hair mt-6 border-t pt-4 text-[12.5px]">
            Designed in {step}. This shell exists so the layout can be judged first.
          </p>
        )}
      </div>
    </div>
  )
}
