// One pack out of a list. Choosing a starter at sign-up, and changing it later.
export default function PackPicker({ packs, value, onChange, label }) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">{label}</legend>
      <div className="flex flex-col gap-2">
        {packs.map(pack => (
          <label
            key={pack.id}
            className="border-hair flex min-h-[46px] cursor-pointer items-center gap-3 rounded-lg border bg-white px-3 py-2 text-[14px] hover:bg-slate-50"
          >
            <input
              type="radio"
              name={label}
              checked={value === pack.id}
              onChange={() => onChange(pack.id)}
              className="text-navy h-4 w-4 shrink-0"
            />
            {pack.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
