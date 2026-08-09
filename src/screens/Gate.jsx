import { isTestMode } from '../lib/supabase.js'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import Notice from '../components/Notice.jsx'
import GateLayout from './GateLayout.jsx'
import AuthScreen from './AuthScreen.jsx'
import OnboardingScreen from './OnboardingScreen.jsx'
import DataBoot from './DataBoot.jsx'

// config → auth → onboarding → app.
//
// Each stage is a precondition for the next, so they are checked in order and
// the first unmet one is what the person sees. The app itself is only mounted
// once there is a session AND a team, which is what lets every page below
// assume both exist rather than defending against null.
export default function Gate({ children }) {
  const { configured, loading: authLoading, session } = useAuth()
  const { team, loading: teamLoading, error: teamError } = useTeam()

  // Test mode goes straight through to the app on localStorage. Checked first
  // so nothing below it — not even the loading state — can hold the suites up.
  if (isTestMode) return children

  if (!configured) {
    return (
      <GateLayout
        title="Not connected to a backend"
        subtitle="This build went out without its Supabase credentials, so there is nothing to sign in to."
      >
        <div className="space-y-3 text-[13px] leading-relaxed text-ink-soft">
          <p>
            Set <code className="font-mono text-ink">VITE_SUPABASE_URL</code> and{' '}
            <code className="font-mono text-ink">VITE_SUPABASE_ANON_KEY</code>, then build again.
          </p>
          <p>
            Locally that means a <code className="font-mono text-ink">.env</code> file — copy{' '}
            <code className="font-mono text-ink">.env.example</code>. For the deployed site they are
            repository secrets read by the Actions workflow.
          </p>
        </div>
      </GateLayout>
    )
  }

  // One spinner for both loads. Splitting them makes the screen flash twice on
  // a cold start for no benefit.
  if (authLoading || (session && teamLoading)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-stage">
        <p className="text-[13.5px] text-ink-soft" role="status">
          Loading…
        </p>
      </div>
    )
  }

  if (!session) return <AuthScreen />

  if (teamError) {
    return (
      <GateLayout title="Could not load your team">
        <Notice blocked title={teamError.message}>
          If this says the schema is missing, the migrations in{' '}
          <code className="font-mono">supabase/migrations/</code> have not been run against this
          project yet.
        </Notice>
      </GateLayout>
    )
  }

  if (!team) return <OnboardingScreen />

  // Last stage: the team's data has to be in the cache before any page reads it.
  return <DataBoot>{children}</DataBoot>
}
