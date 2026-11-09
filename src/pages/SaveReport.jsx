import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import {
  claimReport,
  createProperty,
  deliveryByToken,
  fileReport,
  listClients,
  receivingTeams,
} from '../lib/api.js'
import { defaultAccountName, propertyChoices, siteLine } from '../lib/reportLink.js'
import Notice from '../components/Notice.jsx'
import { GateButton } from '../screens/GateLayout.jsx'

// "Save to your account" on a report link (D3c, build plan 2.10). Only the
// address the report was sent to can save it: claim_report() checks that, not
// this page. Saved, it files itself under a property with the same address, or
// asks which property it's for, or makes one from the report's address under
// its owner (M.D.: an owner of that name already in the account is reused).
//
// Someone with no landlord or agency account gets one here. Only a report link
// opens that: general sign-up for landlords and agencies opens in D4.

const section = 'border-hair mt-6 border-t pt-5'
const heading = 'text-ink text-[14px] font-semibold'
const soft = 'text-ink-soft mt-1 text-[13px] leading-relaxed'
const input =
  'border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none'

const KINDS = [
  { id: 'landlord', label: 'Landlord', hint: 'I own the property' },
  { id: 'agency', label: 'Property management', hint: 'I manage it for its owner' },
]

/** Saved, and where it was filed. "Open Pemcora" goes to that account. */
export function Saved({ team, where }) {
  const { setActiveTeam } = useTeam()
  return (
    <div className="space-y-3">
      <Notice title={`Saved to ${team.name}${where ? `, filed under ${where}` : ''}.`}>
        {where
          ? 'The next report from this electrician for the property files itself there.'
          : 'It is in your account, not filed under a property yet.'}
      </Notice>
      <GateButton
        type="button"
        onClick={() => {
          setActiveTeam(team.id)
          window.location.hash = '#/'
        }}
      >
        Open Pemcora
      </GateButton>
    </div>
  )
}

/** Which property a saved report is for: one already in the account, or a new one from its address. */
export function FileReport({ team, delivery, onDone }) {
  const [choices, setChoices] = useState(null)
  const [choice, setChoice] = useState('new')
  const [owner, setOwner] = useState(delivery.snapshot?.client ?? '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const address = siteLine(delivery.site)

  useEffect(() => {
    let alive = true
    listClients(team.id)
      .then(clients => alive && setChoices(propertyChoices(clients)))
      .catch(e => alive && setProblem(e.message))
    return () => {
      alive = false
    }
  }, [team.id])

  const file = async () => {
    setBusy(true)
    setProblem('')
    try {
      if (choice === 'new') {
        const place = await createProperty(team.id, owner, delivery.site)
        await fileReport(delivery.id, place.id)
        onDone(address)
      } else {
        await fileReport(delivery.id, choice)
        onDone(choices.find(c => c.id === choice)?.label ?? null)
      }
    } catch (e) {
      setProblem(e.message || 'It could not be filed.')
      setBusy(false)
    }
  }

  const option = (id, children) => (
    <label
      key={id}
      className={`border-hair flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 ${choice === id ? 'border-navy bg-navy/5' : ''}`}
    >
      <input
        type="radio"
        name="property"
        checked={choice === id}
        onChange={() => setChoice(id)}
        className="mt-1"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )

  return (
    <div className="space-y-3">
      <div>
        <p className={heading}>Which property is it for?</p>
        <p className={soft}>Saved to {team.name}. Nothing there has this address yet.</p>
      </div>
      <div className="space-y-2" role="radiogroup" aria-label="Property">
        {option(
          'new',
          <span className="text-ink block text-[13.5px] font-semibold">
            A new property: {address || 'the report’s address'}
          </span>,
        )}
        {/* Beside the choice, not in it, so the choice's name is just the address. */}
        {choice === 'new' && (
          <label className="block pl-9">
            <span className="text-ink-soft mb-1 block text-[12.5px] font-semibold">Owner</span>
            <input value={owner} onChange={e => setOwner(e.target.value)} className={input} />
          </label>
        )}
        {(choices ?? []).map(c =>
          option(
            c.id,
            <>
              <span className="text-ink block text-[13.5px] font-semibold">{c.label}</span>
              <span className="text-ink-soft block text-[12.5px]">{c.owner}</span>
            </>,
          ),
        )}
      </div>
      {problem && <Notice blocked title={problem} />}
      <GateButton
        type="button"
        disabled={busy || (choice === 'new' && !owner.trim())}
        onClick={file}
      >
        {busy ? 'Filing…' : 'File it'}
      </GateButton>
      <button
        type="button"
        disabled={busy}
        onClick={() => onDone(null)}
        className="text-navy w-full text-center text-[13px] font-semibold underline-offset-2 hover:underline"
      >
        File it later
      </button>
    </div>
  )
}

/**
 * Saving a report from its link, for a report nobody has saved yet. Signed out,
 * it offers an account; signed in, the person's landlord or agency accounts.
 */
export default function SaveReport({ token, expired, onAuth }) {
  const { session, user, signOut } = useAuth()
  const { createOrganisation } = useTeam()
  const [stage, setStage] = useState({ name: 'loading' })
  const [problem, setProblem] = useState(null)
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState('landlord')
  const [name, setName] = useState(defaultAccountName(user?.email))
  const [teamId, setTeamId] = useState('')

  const load = useCallback(async () => {
    setStage({ name: 'loading' })
    setProblem(null)
    try {
      const [teams, delivery] = await Promise.all([receivingTeams(), deliveryByToken(token)])
      // Readable here by its sender's team only, since nobody has saved it.
      if (delivery) return setStage({ name: 'sender' })
      setTeamId(teams[0]?.id ?? '')
      setStage(teams.length ? { name: 'choose', teams } : { name: 'new' })
    } catch (e) {
      setProblem({ message: e.message || 'Your accounts could not be loaded.' })
      setStage({ name: 'error' })
    }
  }, [token])

  useEffect(() => {
    if (session) load()
  }, [session, load])

  useEffect(() => {
    setName(defaultAccountName(user?.email))
  }, [user?.email])

  const claim = async team => {
    const delivery = await claimReport(token, team.id)
    setStage(
      delivery.recipient_location_id
        ? { name: 'done', team, where: siteLine(delivery.site) }
        : { name: 'filing', team, delivery },
    )
  }

  const attempt = async work => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (e) {
      setProblem({
        message: e.message || 'It could not be saved.',
        wrongAccount: /sent to someone else/i.test(e.message ?? ''),
      })
    }
    setBusy(false)
  }

  const intro = expired
    ? 'The link has expired, but the report can still be saved: saving never expires.'
    : 'Keep it in a free Pemcora account, with the property’s due dates. Later reports for the same property file themselves.'

  if (!session) {
    return (
      <div className={section}>
        <p className={heading}>Save this report to your account</p>
        <p className={soft}>{intro} Use the email address it was sent to.</p>
        <div className="mt-4 space-y-2">
          <GateButton type="button" onClick={() => onAuth('sign-up')}>
            Create a free account
          </GateButton>
          <button
            type="button"
            onClick={() => onAuth('sign-in')}
            className="text-navy w-full text-center text-[13px] font-semibold underline-offset-2 hover:underline"
          >
            I have an account
          </button>
        </div>
      </div>
    )
  }

  const wrongAccount = problem?.wrongAccount && (
    <button
      type="button"
      onClick={signOut}
      className="text-navy w-full text-center text-[13px] font-semibold underline-offset-2 hover:underline"
    >
      Sign out, to sign in with the address it was sent to
    </button>
  )

  return (
    <div className={section}>
      {stage.name === 'loading' && (
        <p className="text-ink-soft text-[13px]" role="status">
          Looking up your accounts…
        </p>
      )}

      {stage.name === 'error' && (
        <div className="space-y-3">
          <Notice blocked title={problem?.message} />
          <GateButton type="button" onClick={load}>
            Try again
          </GateButton>
        </div>
      )}

      {stage.name === 'sender' && (
        <p className={soft}>
          Your team sent this report. Only the person it was sent to can save it.
        </p>
      )}

      {stage.name === 'new' && (
        <div className="space-y-3">
          <div>
            <p className={heading}>Save this report to a new account</p>
            <p className={soft}>
              Signed in as {user?.email}. {expired ? 'Saving never expires. ' : ''}Make a free
              account for the properties you own or manage, and the report goes into it. Only the
              address it was sent to can save it.
            </p>
          </div>
          <div className="space-y-2" role="radiogroup" aria-label="Account type">
            {KINDS.map(k => (
              <label
                key={k.id}
                className={`border-hair flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 ${kind === k.id ? 'border-navy bg-navy/5' : ''}`}
              >
                <input
                  type="radio"
                  name="kind"
                  checked={kind === k.id}
                  onChange={() => setKind(k.id)}
                  className="mt-1"
                />
                <span>
                  <span className="text-ink block text-[13.5px] font-semibold">{k.label}</span>
                  <span className="text-ink-soft block text-[12.5px]">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="block">
            <span className="text-ink-soft mb-1 block text-[12.5px] font-semibold">
              Account name
            </span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              aria-label="Account name"
              className={input}
            />
          </label>
          {problem && <Notice blocked title={problem.message} />}
          {wrongAccount}
          <GateButton
            type="button"
            disabled={busy || !name.trim()}
            onClick={() =>
              attempt(async () => {
                const before = new Set((await receivingTeams()).map(t => t.id))
                const { error } = await createOrganisation({ name: name.trim(), accountType: kind })
                if (error) throw error
                const made = (await receivingTeams()).find(t => !before.has(t.id))
                if (!made)
                  throw new Error('The account was made, but could not be found. Try again.')
                setStage({ name: 'choose', teams: [made] })
                setTeamId(made.id)
                await claim(made)
              })
            }
          >
            {busy ? 'Saving…' : 'Make the account and save'}
          </GateButton>
        </div>
      )}

      {stage.name === 'choose' && (
        <div className="space-y-3">
          <div>
            <p className={heading}>Save this report to your account</p>
            <p className={soft}>
              Signed in as {user?.email}. Only the address it was sent to can save it.
            </p>
          </div>
          {stage.teams.length > 1 && (
            <label className="block">
              <span className="text-ink-soft mb-1 block text-[12.5px] font-semibold">Account</span>
              <select
                value={teamId}
                onChange={e => setTeamId(e.target.value)}
                aria-label="Account"
                className={input}
              >
                {stage.teams.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {problem && <Notice blocked title={problem.message} />}
          {wrongAccount}
          <GateButton
            type="button"
            disabled={busy}
            onClick={() =>
              attempt(() => claim(stage.teams.find(t => t.id === teamId) ?? stage.teams[0]))
            }
          >
            {busy
              ? 'Saving…'
              : `Save to ${(stage.teams.find(t => t.id === teamId) ?? stage.teams[0]).name}`}
          </GateButton>
        </div>
      )}

      {stage.name === 'filing' && (
        <FileReport
          team={stage.team}
          delivery={stage.delivery}
          onDone={where => setStage({ name: 'done', team: stage.team, where })}
        />
      )}

      {stage.name === 'done' && <Saved team={stage.team} where={stage.where} />}
    </div>
  )
}
