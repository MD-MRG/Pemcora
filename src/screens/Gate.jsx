import { useAuth } from '../context/AuthContext.jsx'
import { useTeam } from '../context/TeamContext.jsx'
import Notice from '../components/Notice.jsx'
import GateLayout from './GateLayout.jsx'
import AuthScreen from './AuthScreen.jsx'
import OnboardingScreen from './OnboardingScreen.jsx'

// config → auth → onboarding → app.
//
// Each stage is a precondition for the next, so they are checked in order and
// the first unmet one is what the person sees. The app itself is only mounted
// once there is a session AND a team, which is what lets every page below
// assume both exist rather than defending against null.
export default function Gate({ children }) {
  const { configured, loading: authLoading, session } = useAuth()
  const { team, loading: teamLoading, error: teamError } = useTeam()

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

  return children
}
