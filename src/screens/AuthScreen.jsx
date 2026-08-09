import { useState } from 'react'
import { useAuth } from '../context/auth.js'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import GateLayout, { GateButton } from './GateLayout.jsx'

export default function AuthScreen() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState('sign-in') // 'sign-in' | 'sign-up'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [notice, setNotice] = useState('')

  const signingUp = mode === 'sign-up'

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
          }}
          className="font-semibold text-navy underline-offset-2 hover:underline"
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

        <GateButton type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Working…' : signingUp ? 'Create account' : 'Sign in'}
        </GateButton>
      </form>
    </GateLayout>
  )
}
