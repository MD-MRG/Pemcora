import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import Notice from '../components/Notice.jsx'
import GateLayout, { GateButton } from './GateLayout.jsx'

// Naming a team used to be the first thing anyone was asked for, on a screen
// between the confirmation email and the app. It was a poor first question: at
// that moment nobody knows what the answer changes, and the name is editable on
// the Teams page five seconds later anyway. So the team is now created without
// asking, and this screen is only ever seen for the instant that takes — or, if
// the call fails, for as long as it takes to retry.
//
// Whoever gets here owns the team they get. Invited people never reach this
// screen: their membership is created when they confirm their email, so they
// arrive already in someone else's team as a member.

// "michal.dolezal@…" becomes "Michal Dolezal's team" — obviously a placeholder,
// and distinct enough that a roster of several teams still reads.
function defaultTeamName(email) {
  const local = String(email ?? '')
    .split('@')[0]
    .split('+')[0]
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ')
  return words ? `${words}'s team` : 'My Team'
}

export default function TeamSetup() {
  const { user, signOut } = useAuth()
  const { createTeam } = useTeam()
  const [problem, setProblem] = useState('')
  const [attempt, setAttempt] = useState(0)
  const email = user?.email

  // StrictMode runs every effect twice in development. Without this guard that
  // is two create_team calls and two teams, and the second one is invisible
  // until someone opens the Teams page and wonders where it came from.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    createTeam(defaultTeamName(email)).then(({ error }) => {
      // On success TeamContext refreshes and the gate lets the app through, so
      // there is no success state to render here.
      if (error) setProblem(error.message)
    })
    // No cleanup, and deliberately none. The usual `let alive = true` guard is
    // wrong under StrictMode: its cleanup runs between the two development
    // mounts, so the one call that did go out has its result thrown away and
    // the screen sits on "Setting up your workspace…" forever, whatever the
    // server said. The call is already guarded against firing twice, and a
    // setState after unmount is a no-op in React 18 and later.
  }, [attempt, email, createTeam])

  if (!problem) {
    return (
      <div className="bg-stage flex min-h-dvh items-center justify-center">
        <p className="text-ink-soft text-[13.5px]" role="status">
          Setting up your workspace…
        </p>
      </div>
    )
  }

  return (
    <GateLayout
      title="Could not finish setting up"
      subtitle="Your account exists, but the team that holds your clients and visits was not created."
      footer={
        <p className="text-[12.5px]">
          Signed in as {user?.email}.{' '}
          <button
            type="button"
            onClick={signOut}
            className="text-navy font-semibold underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        </p>
      }
    >
      <div className="space-y-4">
        <Notice blocked title={problem} />
        <GateButton
          type="button"
          onClick={() => {
            setProblem('')
            started.current = false
            setAttempt(n => n + 1)
          }}
        >
          Try again
        </GateButton>
      </div>
    </GateLayout>
  )
}
