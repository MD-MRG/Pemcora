import { useEffect, useSyncExternalStore } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext.jsx'
import { TeamProvider } from './context/TeamContext.jsx'
import Gate from './screens/Gate.jsx'
import AppShell from './layout/AppShell.jsx'
import Home from './pages/Home.jsx'
import NewClient from './pages/NewClient.jsx'
import EditClient from './pages/EditClient.jsx'
import Commissioning from './pages/Commissioning.jsx'
import PreventativeMaintenance from './pages/PreventativeMaintenance.jsx'
import CustomList from './pages/CustomList.jsx'
import Teams from './pages/Teams.jsx'
import Settings from './pages/Settings.jsx'
import Due from './pages/Due.jsx'
import ReceivingHolding from './pages/ReceivingHolding.jsx'
import Reports from './pages/Reports.jsx'
import Workflow from './pages/Workflow.jsx'
import ReportLink from './pages/ReportLink.jsx'
import { isReportLink, takePendingReport } from './lib/reportLink.js'
import { useAuth } from './context/auth.js'
import { WORKFLOW_NAV } from './nav.js'

// Every other workflow's page comes from the pack registry. These three have
// files of their own.
const OWN_PAGES = new Set(['maintenance', 'commissioning', 'custom'])
const REGISTRY_PAGES = WORKFLOW_NAV.filter(item => !OWN_PAGES.has(item.workflow))

// HashRouter: real URLs and a working back button, with no GitHub Pages
// 404 rewrite needed and no dependency on the deploy sub-path.
//
// Gate sits inside the providers but outside the router: signing in is not a
// route. Putting it here means no page has to ask whether there is a session.
//
// A report link (#/r/<token>, D3) is the exception: it's for whoever holds it,
// signed in or not, so it goes in front of the gate.
const watchHash = notify => {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}
const currentHash = () => window.location.hash

// Someone who made an account to save a report confirms it from their email,
// which opens the app, not the report. Signed in, they're taken back to it, once.
function BackToReport() {
  const { session, loading } = useAuth()
  useEffect(() => {
    if (loading || !session) return
    const token = takePendingReport()
    if (token && !isReportLink(window.location.hash)) window.location.hash = `#/r/${token}`
  }, [session, loading])
  return null
}

export default function App() {
  const hash = useSyncExternalStore(watchHash, currentHash)
  return (
    <AuthProvider>
      <TeamProvider>
        <BackToReport />
        {isReportLink(hash) ? (
          <ReportLink hash={hash} />
        ) : (
          <Gate>
            <HashRouter>
              <Routes>
                <Route element={<AppShell />}>
                  <Route path="/" element={<Home />} />
                  <Route path="/new-client" element={<NewClient />} />
                  <Route path="/edit-client" element={<EditClient />} />
                  <Route path="/commissioning" element={<Commissioning />} />
                  <Route path="/maintenance" element={<PreventativeMaintenance />} />
                  <Route path="/custom-list" element={<CustomList />} />
                  {REGISTRY_PAGES.map(item => (
                    <Route
                      key={item.path}
                      path={item.path}
                      element={<Workflow id={item.workflow} />}
                    />
                  ))}
                  <Route path="/checks-due" element={<Due />} />
                  <Route path="/teams" element={<Teams />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/properties" element={<ReceivingHolding page="properties" />} />
                  <Route path="/reports" element={<Reports />} />
                  <Route path="/due" element={<ReceivingHolding page="due" />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </HashRouter>
          </Gate>
        )}
      </TeamProvider>
    </AuthProvider>
  )
}
