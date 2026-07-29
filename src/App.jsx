import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './layout/AppShell.jsx'
import Home from './pages/Home.jsx'
import NewClient from './pages/NewClient.jsx'
import EditClient from './pages/EditClient.jsx'
import Commissioning from './pages/Commissioning.jsx'
import PreventativeMaintenance from './pages/PreventativeMaintenance.jsx'
import CustomList from './pages/CustomList.jsx'
import Settings from './pages/Settings.jsx'

// HashRouter: real URLs and a working back button, with no GitHub Pages
// 404 rewrite needed and no dependency on the deploy sub-path.
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/new-client" element={<NewClient />} />
          <Route path="/edit-client" element={<EditClient />} />
          <Route path="/commissioning" element={<Commissioning />} />
          <Route path="/maintenance" element={<PreventativeMaintenance />} />
          <Route path="/custom-list" element={<CustomList />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
