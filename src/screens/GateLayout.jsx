import { BrandMark } from '../components/icons.jsx'

// The shell every pre-app screen sits in: not-configured, sign-in, onboarding.
// Centred and narrow on purpose — none of these is a place to linger, and the
// full navy rail would imply an app the person cannot reach yet.
export default function GateLayout({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-stage px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-navy text-brass">
            <BrandMark size={24} />
          </div>
          <div>
            <p className="text-[17px] leading-tight font-semibold text-ink">Pemcora</p>
            <p className="text-[12.5px] text-ink-soft">AV Service</p>
          </div>
        </div>

        <div className="border-hair rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="text-[16px] font-semibold text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>

        {footer && <div className="mt-4 text-center text-[13px] text-ink-soft">{footer}</div>}
      </div>
    </div>
  )
}

export function GateButton({ children, disabled, ...rest }) {
  return (
    <button
      disabled={disabled}
      className="w-full rounded-lg bg-navy px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-navy-item disabled:cursor-not-allowed disabled:opacity-55"
      {...rest}
    >
      {children}
    </button>
  )
}
