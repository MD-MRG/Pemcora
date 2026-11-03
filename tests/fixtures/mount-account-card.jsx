// Puts the account card on the page by itself, for tests/offline.mjs. The real one
// only renders with a session, and the suites run without one. Served by the dev
// server; nothing in src/ imports it, so it never reaches a build.
import { createRoot } from 'react-dom/client'
import { AccountCard } from '../../src/components/AccountPanel.jsx'

export function mountAccountCard({ unsaved }) {
  const calls = (window.__signOuts = [])
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  createRoot(host).render(
    <AccountCard
      email="sam@example.com"
      teamName="Northpoint"
      role="member"
      onCheck={async () => unsaved}
      onSignOut={choice => calls.push(choice)}
    />,
  )
}
