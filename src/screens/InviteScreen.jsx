import { useEffect, useState } from 'react'
import { inviteTokenInUrl, clearInviteFromUrl } from '../lib/supabase.js'
import { previewInvite, acceptInvite } from '../lib/api.js'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import Notice from '../components/Notice.jsx'
import GateLayout, { GateButton } from './GateLayout.jsx'
import AuthScreen from './AuthScreen.jsx'

/**
 * What an invitation link opens.
 *
 * Two people arrive here. The one the invitation was written for has no
 * account, and gets the sign-up form with their address already in it and not
 * editable — the address is what the invitation is for, and typing a different
 * one would produce an account the trigger refuses to place in any team.
 *
 * The other already has an account, arrives with a session, and is simply
 * asked whether to join. That case cannot go through the confirm trigger:
 * their address was confirmed months ago and no second confirmation is coming
 * to hang the membership off, which is what accept_invite exists for.
 */
export default function InviteScreen({ onDismiss }) {
  const { session } = useAuth()
  const { refresh, setActiveTeam } = useTeam()
  const [state, setState] = useState('loading') // 'loading' | 'ready' | 'gone'
  const [invite, setInvite] = useState(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    previewInvite(inviteTokenInUrl)
      .then(row => {
        if (!alive) return
        setInvite(row)
        // Expired, already used, or never existed all end the same way: there
        // is nothing to accept and only the team's owner can change that.
        setState(!row || row.expired || row.accepted ? 'gone' : 'ready')
      })
      .catch(e => {
        if (!alive) return
        setProblem(e.message)
        setState('gone')
      })
    return () => {
      alive = false
    }
  }, [])

  function dismiss() {
    clearInviteFromUrl()
    onDismiss()
  }

  async function accept() {
    setProblem('')
    setBusy(true)
    try {
      const team = await acceptInvite(inviteTokenInUrl)
      await refresh()
      // Land them in the team they just joined rather than whichever one they
      // happened to be working in — joining is a deliberate act, and this is
      // the only moment its intent is unambiguous.
      setActiveTeam(team.id)
      dismiss()
    } catch (e) {
      setProblem(e.message)
      setBusy(false)
    }
  }

  if (state === 'loading') {
    return (
      <div className="bg-stage flex min-h-dvh items-center justify-center">
        <p className="text-ink-soft text-[13.5px]" role="status">
          Checking your invitation…
        </p>
      </div>
    )
  }

  if (state === 'gone') {
    const why = problem
      ? problem
      : !invite
        ? 'That invitation link is not valid.'
        : invite.accepted
          ? 'That invitation has already been used.'
          : 'That invitation has expired.'
    return (
      <GateLayout title="This invitation cannot be used">
        <div className="space-y-4">
          <Notice blocked title={why}>
            Invitations last a week. Ask whoever invited you to send a new one — they can do that
            from the Teams page.
          </Notice>
          <GateButton type="button" onClick={dismiss}>
            Continue to Pemcora
          </GateButton>
        </div>
      </GateLayout>
    )
  }

  // Signed in already: nothing to create, just a decision to make.
  if (session) {
    return (
      <GateLayout
        title={`Join ${invite.teamName}?`}
        subtitle={`This invitation was sent to ${invite.email}. Joining gives you that team's clients, visits and reports; it does not take away any team you are already in.`}
        footer={
          <button
            type="button"
            onClick={dismiss}
            className="text-navy font-semibold underline-offset-2 hover:underline"
          >
            Not now
          </button>
        }
      >
        <div className="space-y-4">
          {problem && <Notice blocked title={problem} />}
          <GateButton type="button" disabled={busy} onClick={accept}>
            {busy ? 'Joining…' : `Join ${invite.teamName}`}
          </GateButton>
        </div>
      </GateLayout>
    )
  }

  return <AuthScreen invite={{ ...invite, token: inviteTokenInUrl }} />
}
