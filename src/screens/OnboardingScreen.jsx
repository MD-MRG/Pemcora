import { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useTeam } from '../context/TeamContext.jsx'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import GateLayout, { GateButton } from './GateLayout.jsx'

// Signed in, but in no team yet. Create one and you own it; join one with a
// colleague's invite code and you are a member until the owner says otherwise.
export default function OnboardingScreen() {
  const { user, signOut } = useAuth()
  const { createTeam, joinTeam } = useTeam()
  const [mode, setMode] = useState('create') // 'create' | 'join'
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  const creating = mode === 'create'

  async function submit(e) {
    e.preventDefault()
    setProblem('')
    setBusy(true)
    const { error } = creating ? await createTeam(name.trim()) : await joinTeam(code.trim())
    setBusy(false)
    // On success TeamContext refreshes and the gate lets the app through.
    if (error) setProblem(error.message)
  }

  return (
    <GateLayout
      title={creating ? 'Name your team' : 'Join a team'}
      subtitle={
        creating
          ? 'Everything you record belongs to this team. You will be its owner — the only person who can grant admin.'
          : 'Ask a colleague for the six-character invite code from their Settings page.'
      }
      footer={
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              setMode(creating ? 'join' : 'create')
              setProblem('')
            }}
            className="font-semibold text-navy underline-offset-2 hover:underline"
          >
            {creating ? 'I have an invite code' : 'Create a new team instead'}
          </button>
          <p className="text-[12.5px]">
            Signed in as {user?.email}.{' '}
            <button
              type="button"
              onClick={signOut}
              className="font-semibold text-navy underline-offset-2 hover:underline"
            >
              Sign out
            </button>
          </p>
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {creating ? (
          <Field
            label="Team name"
            value={name}
            onChange={setName}
            required
            placeholder="e.g. Mergetec Field Services"
          />
        ) : (
          <Field
            label="Invite code"
            value={code}
            onChange={v => setCode(v.toUpperCase())}
            required
            maxLength={6}
            placeholder="ABC123"
            className="[&_input]:font-mono [&_input]:tracking-[.2em] [&_input]:uppercase"
          />
        )}

        {problem && <Notice blocked title={problem} />}

        <GateButton type="submit" disabled={busy || (creating ? !name.trim() : code.length < 6)}>
          {busy ? 'Working…' : creating ? 'Create team' : 'Join team'}
        </GateButton>
      </form>
    </GateLayout>
  )
}
