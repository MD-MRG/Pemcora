import { useState } from 'react'
import { useAuth } from '../context/auth.js'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import GateLayout, { GateButton } from './GateLayout.jsx'

// Where a reset link lands. The link has already signed this person in — that
// is how GoTrue does recovery — so the gate has a session and would otherwise
// wave them into the app with the old password still unchanged.
export default function NewPasswordScreen() {
  const { user, updatePassword, endRecovery, signOut } = useAuth()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  async function submit(e) {
    e.preventDefault()
    setProblem('')

    if (password.length < 8) {
      setProblem('Use at least 8 characters.')
      return
    }
    if (password !== again) {
      setProblem('Those two do not match.')
      return
    }

    setBusy(true)
    const { error } = await updatePassword(password)
    setBusy(false)
    if (error) {
      setProblem(error.message)
      return
    }
    // Still signed in, and now with a password they know. Clearing the flag is
    // all that stands between here and the app.
    endRecovery()
  }

  return (
    <GateLayout
      title="Set a new password"
      subtitle={`For ${user?.email ?? 'your account'}. You are signed in on this device already — this is the last step.`}
      footer={
        <button
          type="button"
          onClick={signOut}
          className="text-navy font-semibold underline-offset-2 hover:underline"
        >
          Cancel and sign out
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          required
          autoComplete="new-password"
          placeholder="At least 8 characters"
        />
        <Field
          label="New password again"
          type="password"
          value={again}
          onChange={setAgain}
          required
          autoComplete="new-password"
        />

        {problem && <Notice blocked title={problem} />}

        <GateButton type="submit" disabled={busy || !password || !again}>
          {busy ? 'Working…' : 'Save password'}
        </GateButton>
      </form>
    </GateLayout>
  )
}
