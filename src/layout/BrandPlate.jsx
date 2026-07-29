import { BrandMark } from '../components/icons.jsx'

// Top-left plate. Colour comes from CSS custom properties so a swatch change
// repaints every instance at once. In rail mode only the mark survives.
export default function BrandPlate({ collapsed = false, name = 'Field Console', tagline = 'AV Service' }) {
  return (
    <div
      className={`flex h-full items-center overflow-hidden ${collapsed ? 'justify-center px-0' : 'gap-3 px-4'}`}
      style={{
        background: 'var(--plate-bg)',
        color: 'var(--plate-fg)',
        borderRight: '1px solid var(--plate-edge)',
        borderBottom: '1px solid var(--plate-edge)',
        transition: 'background-color .28s ease, color .28s ease',
      }}
    >
      <div
        className="grid shrink-0 place-items-center rounded-[9px]"
        style={{
          width: 40,
          height: 40,
          background: 'var(--plate-mark)',
          border: '1px solid var(--plate-edge)',
        }}
      >
        <BrandMark size={22} />
      </div>

      {!collapsed && (
        <div className="min-w-0">
          <b className="block truncate text-[15.5px] leading-tight font-bold tracking-[.01em]">
            {name}
          </b>
          <span className="block truncate text-[9.5px] tracking-[.16em] uppercase opacity-70">
            {tagline}
          </span>
        </div>
      )}
    </div>
  )
}
