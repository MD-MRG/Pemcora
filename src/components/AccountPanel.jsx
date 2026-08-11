import { useState } from 'react'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import ConfirmDialog from './ConfirmDialog.jsx'

// Signing out had no route into it. `signOut` existed on the auth context from
// the beginning, but the only button wired to it sat on a gate screen shown
// while you had NO team. So the moment setup was finished the button became
// unreachable, and the sole way out was to clear localStorage by hand. This is
// now the only sign-out in the app, which is why it is on the page everyone can
// reach rather than on a screen most people see once.

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' }

// The presentational half, kept separate so the card can be rendered and looked
// at without a real session standing behind it.
export function AccountCard({ email, teamName, role, onSignOut }) {
  const [asking, setAsking] = useState(false)

  return (
    <section className="border-hair rounded-xl border bg-white p-6">
      <h2 className="text-[19px] font-bold tracking-[-.01em]">Account</h2>
      <p className="text-ink-soft mt-1 max-w-[62ch] text-[14px]">
        Who this device is signed in as. Your work is saved to the team as you go, so signing out
        never costs you anything you have entered.
      </p>

      <dl className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-ink-soft text-[12.5px] font-semibold">Signed in as</dt>
          <dd className="m-0 mt-1 truncate text-[14px]">{email}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ink-soft text-[12.5px] font-semibold">Team</dt>
          <dd className="m-0 mt-1 truncate text-[14px]">
            {teamName}
            {role && <span className="text-ink-soft"> · {ROLE_LABEL[role] ?? role}</span>}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => setAsking(true)}
        className="border-hair text-ink mt-5 min-h-[46px] rounded-lg border px-5 text-[13.5px] font-semibold hover:bg-slate-50"
      >
        Sign out
      </button>

      {/* ConfirmDialog, never window.confirm — a native dialog is auto-dismissed
          in an embedded webview and the button would silently do nothing. */}
      {asking && (
        <ConfirmDialog
          title="Sign out of Pemcora?"
          confirmLabel="Sign out"
          cancelLabel="Stay signed in"
          onCancel={() => setAsking(false)}
          onConfirm={onSignOut}
        >
          Everything you have entered is already saved to your team. You will need your password to
          sign back in, so do not do this mid-visit on a site with no signal.
        </ConfirmDialog>
      )}
    </section>
  )
}

export default function AccountPanel() {
  const { session, user, signOut } = useAuth()
  const { team, role } = useTeam()

  // No session means the app is running on localStorage — the headless suites,
  // or a dev run without a backend. There is nothing to sign out of, and
  // reading user.email would throw.
  if (!session) return null

  return (
    <AccountCard
      email={user?.email ?? ''}
      teamName={team?.name ?? '—'}
      role={role}
      onSignOut={signOut}
    />
  )
}
