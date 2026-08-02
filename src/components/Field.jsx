import { useId } from 'react'

// Labelled text input on the navy/brass tokens. Shared by New Client, and
// reused by Edit Client and Settings as those arrive.
export default function Field({
  label,
  value,
  onChange,
  placeholder,
  required = false,
  inputRef,
  className = '',
  ...rest
}) {
  const id = useId()
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[12.5px] font-semibold tracking-[.01em] text-ink-soft"
      >
        {label}
        {required && (
          <span className="ml-1 text-fail" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <input
        id={id}
        ref={inputRef}
        value={value}
        required={required}
        aria-required={required || undefined}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className="border-hair w-full rounded-lg border bg-white px-3 py-2.5 text-[14.5px] text-ink outline-none placeholder:text-slate-400 focus:border-navy"
        {...rest}
      />
    </div>
  )
}
