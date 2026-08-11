import { NavLink } from 'react-router-dom'
import { MAIN_NAV, FOOT_NAV } from '../nav.js'
import { useCanManage } from '../context/team.js'
import { IconChevron } from '../components/icons.jsx'

function NavItem({ item, collapsed, onNavigate }) {
  const Icon = item.icon
  return (
    <li className="relative">
      <NavLink
        to={item.path}
        end={item.path === '/'}
        onClick={onNavigate}
        aria-label={collapsed ? item.label : undefined}
        title={collapsed ? item.label : undefined}
        className={({ isActive }) =>
          [
            'group relative flex items-center rounded-[9px] border font-semibold',
            'text-[13.5px] tracking-[.01em] transition-colors',
            collapsed ? 'h-12 justify-center px-0' : 'gap-2.5 px-[14px] py-[13px]',
            isActive
              ? 'bg-brass border-brass-lit text-navy-ink shadow-[inset_0_1px_0_rgba(255,255,255,.35)]'
              : 'bg-navy-item border-navy-edge text-[#dde6ef] hover:bg-[#2b5583]',
          ].join(' ')
        }
      >
        {({ isActive }) => (
          <>
            {/* rail-mode edge marker, carried over from the Console Rail direction */}
            {collapsed && isActive && (
              <span
                aria-hidden="true"
                className="bg-brass absolute -left-[11px] h-6 w-[3px] rounded-r-[3px]"
              />
            )}
            <Icon size={collapsed ? 21 : 19} />
            {!collapsed && <span className="truncate">{item.label}</span>}

            {/* label for rail mode — visible on hover and on keyboard focus */}
            {collapsed && (
              <span
                role="tooltip"
                className="pointer-events-none absolute left-full z-50 ml-3 hidden whitespace-nowrap rounded-md bg-[#0d1c2b] px-2.5 py-1.5 text-[12px] font-medium text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 md:block"
              >
                {item.label}
              </span>
            )}
          </>
        )}
      </NavLink>
    </li>
  )
}

export default function SideNav({ collapsed = false, onToggle, onNavigate, showToggle = true }) {
  // Same test the rest of the app uses for "may this person manage the team",
  // which with no session answers yes — local mode has no team to be an admin
  // of, and hiding the page there would only make it untestable.
  const canManage = useCanManage()
  const items = MAIN_NAV.filter(item => !item.admin || canManage)

  return (
    <nav
      aria-label="Main"
      className={`bg-navy flex h-full flex-col ${collapsed ? 'px-[11px] py-3.5' : 'p-3.5'}`}
    >
      <ul className="flex list-none flex-col gap-2 p-0">
        {items.map(item => (
          <NavItem key={item.key} item={item} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </ul>

      <div className="mt-auto pt-3">
        <div className="mb-3 h-px bg-[#2b527a]" />
        <ul className="flex list-none flex-col gap-2 p-0">
          {FOOT_NAV.map(item => (
            <NavItem key={item.key} item={item} collapsed={collapsed} onNavigate={onNavigate} />
          ))}
        </ul>

        {showToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className={`mt-3 flex h-10 w-full items-center rounded-lg text-[12px] font-semibold tracking-[.02em] text-[#8fabc7] transition-colors hover:bg-[#24486e] hover:text-white ${
              collapsed ? 'justify-center' : 'gap-2 px-3'
            }`}
          >
            <IconChevron size={17} dir={collapsed ? 'right' : 'left'} />
            {!collapsed && <span>Collapse</span>}
          </button>
        )}
      </div>
    </nav>
  )
}
