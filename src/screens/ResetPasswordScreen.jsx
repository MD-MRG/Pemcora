import { useState } from 'react'
import { useAuth } from '../context/auth.js'
import { emailIsRegistered } from '../lib/api.js'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import GateLayout, { GateButton } from './GateLayout.jsx'

export default function ResetPasswordScreen({ initialEmail = '', onBack }) {
  const { resetPassword } = useAuth()
  const [email, setEmail] = useState(initialEmail)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [sent, setSent] = useState('')

  async function submit(e) {
    e.preventDefault()
    setProblem('')
    setSent('')
    setBusy(true)
    const address = email.trim()

    // Say so when there is no such account, rather than sending nothing and
    // claiming to have sent something. If the check itself fails — 0004 not run
    // against this project yet — fall through and send anyway: a working reset
    // with a vaguer message beats no reset at all.
    try {
      if ((await emailIsRegistered(address)) === false) {
        setProblem(`There is no Pemcora account for ${address}.`)
        setBusy(false)
        return
      }
    } catch {
      /* check unavailable — send regardless */
    }

    const { error } = await resetPassword(address)
    setBusy(false)
    if (error) setProblem(error.message)
    else setSent(address)
  }

  return (
    <GateLayout
      title="Reset your password"
      subtitle={
        sent
          ? 'Sent. Open it on this device — the link signs you in and takes you straight to setting a new password.'
          : 'Tell us the address you sign in with and we will send you a link to set a new one.'
      }
      footer={
        <button
          type="button"
          onClick={onBack}
          className="text-navy font-semibold underline-offset-2 hover:underline"
        >
          Back to sign in
        </button>
      }
    >
      {sent ? (
        <div className="space-y-4">
          <Notice title={`Check ${sent} for a link to set a new password.`}>
            The link is good for one hour and can be used once. If it expires, come back here and
            ask for another.
          </Notice>
          <GateButton type="button" onClick={onBack}>
            Back to sign in
          </GateButton>
        </div>
      ) : (
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

          {problem && (
            <Notice blocked title={problem}>
              Check the spelling, or create an account instead — signing up is what makes the
              address a Pemcora account.
            </Notice>
          )}

          <GateButton type="submit" disabled={busy || !email.trim()}>
            {busy ? 'Working…' : 'Send reset link'}
          </GateButton>
        </form>
      )}
    </GateLayout>
  )
}
