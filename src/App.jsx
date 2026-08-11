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

// HashRouter: real URLs and a working back button, with no GitHub Pages
// 404 rewrite needed and no dependency on the deploy sub-path.
//
// Gate sits inside the providers but outside the router: signing in is not a
// route. Putting it here means no page has to ask whether there is a session.
export default function App() {
  return (
    <AuthProvider>
      <TeamProvider>
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
                <Route path="/teams" element={<Teams />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </HashRouter>
        </Gate>
      </TeamProvider>
    </AuthProvider>
  )
}
