import { useState } from 'react'
import { useAuth } from '../context/auth.js'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import GateLayout, { GateButton } from './GateLayout.jsx'
import ResetPasswordScreen from './ResetPasswordScreen.jsx'

export default function AuthScreen() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState('sign-in') // 'sign-in' | 'sign-up' | 'reset'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')
  // Offered only once signing in has actually failed. Shown unprompted it is
  // an invitation to doubt a password you remember perfectly well; shown after
  // a refusal it is the next thing you were going to look for.
  const [refused, setRefused] = useState(false)

  const signingUp = mode === 'sign-up'

  if (mode === 'reset') {
    return (
      <ResetPasswordScreen
        initialEmail={email}
        onBack={() => {
          setMode('sign-in')
          setProblem('')
          setNotice('')
        }}
      />
    )
  }

  async function submit(e) {
    e.preventDefault()
    setProblem('')
    setNotice('')

    if (signingUp && password.length < 8) {
      setProblem('Use at least 8 characters.')
      return
    }

    setBusy(true)
    const { data, error } = signingUp
      ? await signUp(email.trim(), password)
      : await signIn(email.trim(), password)
    setBusy(false)

    if (error) {
      setProblem(error.message)
      if (!signingUp) setRefused(true)
      return
    }
    // With email confirmation switched on, sign-up returns a user but no
    // session. Saying so beats a form that looks like it did nothing.
    if (signingUp && !data?.session) {
      setNotice(`Check ${email.trim()} for a confirmation link, then sign in.`)
      setMode('sign-in')
      setPassword('')
    }
    // On success with a session, AuthContext's listener swaps this screen out.
  }

  return (
    <GateLayout
      title={signingUp ? 'Create your account' : 'Sign in'}
      subtitle={
        signingUp
          ? 'Your clients, visits and reports live with your team, on every device you sign in from.'
          : 'Welcome back.'
      }
      footer={
        <button
          type="button"
          onClick={() => {
            setMode(signingUp ? 'sign-in' : 'sign-up')
            setProblem('')
            setNotice('')
            setRefused(false)
          }}
          className="text-navy font-semibold underline-offset-2 hover:underline"
        >
          {signingUp ? 'I already have an account' : 'Create an account'}
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="email"
          placeholder="you@company.com.au"
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          required
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          placeholder={signingUp ? 'At least 8 characters' : ''}
        />

        {problem && <Notice blocked title={problem} />}
        {notice && <Notice title={notice} />}

        {refused && !signingUp && (
          <button
            type="button"
            onClick={() => setMode('reset')}
            className="text-navy w-full text-center text-[13px] font-semibold underline-offset-2 hover:underline"
          >
            Forgot password?
          </button>
        )}

        <GateButton type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Working…' : signingUp ? 'Create account' : 'Sign in'}
        </GateButton>
      </form>
    </GateLayout>
  )
}
