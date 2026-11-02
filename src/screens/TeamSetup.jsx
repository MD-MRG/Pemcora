import { useState } from 'react'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import Notice from '../components/Notice.jsx'
import TeamChoices from '../components/TeamChoices.jsx'
import GateLayout from './GateLayout.jsx'

// A team's first question used to be its name, and then nothing at all: the name can
// be changed on the Teams page, so the team was created without asking. What it does
// can't be changed, and decides what it's given, so that is what gets asked (build
// plan 2.3). The name still isn't.
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

export default function TeamSetup({ opening }) {
  const { user, signOut } = useAuth()
  const { createOrganisation } = useTeam()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  return (
    <GateLayout
      title="Set up your team"
      subtitle="Your clients, visits and reports live with your team. Tell us what it does, and we'll give it the right checks."
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
        {problem && <Notice blocked title={problem} />}
        <TeamChoices
          opening={opening}
          busy={busy}
          onConfirm={async choice => {
            setBusy(true)
            setProblem('')
            // On success TeamContext refreshes and the gate lets the app through, so
            // there is no success state to render here.
            const { error } = await createOrganisation({
              name: defaultTeamName(user?.email),
              ...choice,
            })
            setBusy(false)
            if (error) setProblem(error.message)
          }}
        />
      </div>
    </GateLayout>
  )
}
