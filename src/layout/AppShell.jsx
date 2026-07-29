import { useState, useEffect, useRef, useCallback } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import BrandPlate from './BrandPlate.jsx'
import ContextBar from './ContextBar.jsx'
import SideNav from './SideNav.jsx'
import { navByPath } from '../nav.js'
import { prefs } from '../lib/prefs.js'
import { applyPlate, DEFAULT_PLATE } from '../lib/plates.js'
import { IconClose } from '../components/icons.jsx'

// Wide enough for "Preventative Maintenance" on one line beside its icon.
const NAV_WIDE = 264
const NAV_RAIL = 68
const BP_PHONE = 768
const BP_WIDE = 1100

const breakpointOf = w => (w < BP_PHONE ? 'phone' : w < BP_WIDE ? 'tablet' : 'wide')

export default function AppShell() {
  const location = useLocation()
  const current = navByPath(location.pathname)

  // null = no manual choice yet, so the breakpoint decides.
  const [manual, setManual] = useState(() => prefs.getCollapsed())
  const [bp, setBp] = useState(() => breakpointOf(window.innerWidth))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [plate, setPlate] = useState(() => prefs.getPlate() ?? DEFAULT_PLATE)
  const bpRef = useRef(bp)

  // A manual choice holds until the layout crosses into a different breakpoint,
  // at which point the new context takes over.
  useEffect(() => {
    const onResize = () => {
      const next = breakpointOf(window.innerWidth)
      if (next !== bpRef.current) {
        bpRef.current = next
        setBp(next)
        setManual(null)
        prefs.setCollapsed(null)
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    applyPlate(plate)
    prefs.setPlate(plate)
  }, [plate])

  // Close the drawer on navigation and on Escape.
  useEffect(() => setDrawerOpen(false), [location.pathname])
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && setDrawerOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isPhone = bp === 'phone'
  const collapsed = isPhone ? false : (manual ?? bp === 'tablet')

  const toggle = useCallback(() => {
    setManual(prev => {
      const next = !(prev ?? bpRef.current === 'tablet')
      prefs.setCollapsed(next)
      return next
    })
  }, [])

  const ctx = { plate, setPlate }

  const skipLink = (
    <a
      href="#stage"
      className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:font-semibold"
    >
      Skip to content
    </a>
  )

  /* ── phone: nav becomes an overlay drawer ─────────────────────────────── */
  if (isPhone) {
    return (
      <div className="flex h-full flex-col">
        {skipLink}
        <header className="h-16 shrink-0">
          <ContextBar item={current} showMenuButton onOpenNav={() => setDrawerOpen(true)} />
        </header>

        <main id="stage" className="bg-stage flex-1 overflow-auto">
          <Outlet context={ctx} />
        </main>

        {drawerOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/45"
              onClick={() => setDrawerOpen(false)}
              aria-hidden="true"
            />
            <div
              className="fixed inset-y-0 left-0 z-50 flex w-[268px] flex-col shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
            >
              <div className="relative h-[76px] shrink-0">
                <BrandPlate collapsed={false} />
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  aria-label="Close navigation"
                  className="absolute top-1/2 right-2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-lg"
                  style={{ color: 'var(--plate-fg)' }}
                >
                  <IconClose size={20} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SideNav collapsed={false} showToggle={false} onNavigate={() => setDrawerOpen(false)} />
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  /* ── laptop & tablet: brand plate top-left, nav left, stage right ─────── */
  return (
    <div
      className="shell-grid h-full"
      style={{
        display: 'grid',
        gridTemplateColumns: `${collapsed ? NAV_RAIL : NAV_WIDE}px 1fr`,
        gridTemplateRows: '88px 1fr',
      }}
    >
      {skipLink}
      <BrandPlate collapsed={collapsed} />
      <ContextBar item={current} />
      <SideNav collapsed={collapsed} onToggle={toggle} />
      <main id="stage" className="bg-stage overflow-auto">
        <Outlet context={ctx} />
      </main>
    </div>
  )
}
