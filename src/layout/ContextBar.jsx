import { IconMenu } from '../components/icons.jsx'

// Sits to the right of the brand plate. Carries the current page's identity;
// the right-hand slot is reserved for per-page actions as pages get built.
export default function ContextBar({ item, onOpenNav, showMenuButton = false }) {
  return (
    <div className="border-hair flex h-full items-center justify-between gap-4 border-b-2 bg-white px-5">
      <div className="flex min-w-0 items-center gap-3">
        {showMenuButton && (
          <button
            type="button"
            onClick={onOpenNav}
            aria-label="Open navigation"
            className="text-navy grid h-11 w-11 shrink-0 place-items-center rounded-lg hover:bg-slate-100"
          >
            <IconMenu size={22} />
          </button>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-[17px] leading-tight font-bold">{item.label}</h1>
          <p className="text-ink-soft truncate text-[12px]">{item.blurb}</p>
        </div>
      </div>

      {/* page actions land here */}
      <div className="flex shrink-0 items-center gap-2" />
    </div>
  )
}
