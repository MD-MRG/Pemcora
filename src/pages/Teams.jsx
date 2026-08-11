import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/auth.js'
import { useTeam } from '../context/team.js'
import { inviteUrl } from '../lib/supabase.js'
import {
  listAllMembers,
  listInvites,
  createInvite,
  revokeInvite,
  updateTeam,
  setMemberRole,
  removeMember,
  moveMember,
} from '../lib/api.js'
import Field from '../components/Field.jsx'
import Notice from '../components/Notice.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import { IconTrash } from '../components/icons.jsx'

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' }

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const daysLeft = iso => {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const days = Math.ceil(ms / 86_400_000)
  return days === 1 ? 'expires today' : `expires in ${days} days`
}

function RoleBadge({ role }) {
  const tone =
    role === 'owner'
      ? 'bg-brass/25 text-navy-ink border-brass-lit'
      : role === 'admin'
        ? 'bg-navy/10 text-navy border-navy/20'
        : 'border-hair text-ink-soft'
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11.5px] font-semibold ${tone}`}>
      {ROLE_LABEL[role] ?? role}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// One team: its details, and the people it is still waiting on
// ─────────────────────────────────────────────────────────────────────────────

function TeamCard({ team, active, onSwitch, onChanged, onProblem }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState(team.description)
  const [invites, setInvites] = useState(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(null)
  const [copied, setCopied] = useState(false)

  const canEdit = team.role === 'owner' || team.role === 'admin'
  const dirty = name.trim() !== team.name || description.trim() !== team.description

  const loadInvites = useCallback(async () => {
    try {
      setInvites(await listInvites(team.id))
    } catch (e) {
      onProblem(e.message)
    }
  }, [team.id, onProblem])

  useEffect(() => {
    if (open && invites === null) loadInvites()
  }, [open, invites, loadInvites])

  async function saveDetails() {
    setBusy(true)
    try {
      await updateTeam(team.id, { name: name.trim(), description: description.trim() })
      await onChanged()
    } catch (e) {
      onProblem(e.message)
    }
    setBusy(false)
  }

  async function invite(e) {
    e.preventDefault()
    setBusy(true)
    setSent(null)
    try {
      const created = await createInvite(team.id, email.trim())
      setSent(created)
      setEmail('')
      setCopied(false)
      await loadInvites()
    } catch (e2) {
      onProblem(e2.message)
    }
    setBusy(false)
  }

  async function revoke(id) {
    try {
      await revokeInvite(id)
      await loadInvites()
    } catch (e) {
      onProblem(e.message)
    }
  }

  return (
    <div className={`border-hair rounded-xl border bg-white ${active ? 'border-navy' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[16px] font-bold">{team.name}</h3>
            <RoleBadge role={team.role} />
            {active && (
              <span className="bg-navy rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-white">
                Working here
              </span>
            )}
          </div>
          <p className="text-ink-soft mt-1 text-[13.5px]">
            {team.description || <i>No description</i>}
          </p>
          <p className="text-ink-soft mt-1.5 text-[12.5px]">
            {plural(team.memberCount, 'person', 'people')} ·{' '}
            {plural(team.adminCount, 'admin', 'admins')}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          {!active && (
            <button
              type="button"
              onClick={() => onSwitch(team.id)}
              className="border-hair text-ink min-h-[42px] rounded-lg border px-4 text-[13px] font-semibold hover:bg-slate-50"
            >
              Work in this team
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            className="border-hair text-ink min-h-[42px] rounded-lg border px-4 text-[13px] font-semibold hover:bg-slate-50"
          >
            {open ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-hair space-y-5 border-t p-5">
          {!canEdit ? (
            <Notice title="You are a member of this team, so its name and invitations are not yours to change." />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Team name" value={name} onChange={setName} required />
                <Field
                  label="Description"
                  value={description}
                  onChange={setDescription}
                  placeholder="What this team covers"
                />
              </div>
              {dirty && (
                <button
                  type="button"
                  onClick={saveDetails}
                  disabled={busy || !name.trim()}
                  className="bg-navy min-h-[42px] rounded-lg px-5 text-[13px] font-semibold text-white hover:bg-[#24486e] disabled:opacity-55"
                >
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
              )}

              <div className="border-hair border-t pt-5">
                <h4 className="text-[14px] font-bold">Invite someone</h4>
                <p className="text-ink-soft mt-0.5 max-w-[62ch] text-[13px]">
                  They join as a member once they have created an account and confirmed the
                  address. Invitations last a week; after that you send a new one.
                </p>

                <form onSubmit={invite} className="mt-3 flex flex-wrap items-end gap-2">
                  <Field
                    label="Email"
                    type="email"
                    value={email}
                    onChange={setEmail}
                    required
                    placeholder="them@company.com.au"
                    className="min-w-[240px] flex-1"
                  />
                  <button
                    type="submit"
                    disabled={busy || !email.trim()}
                    className="bg-navy min-h-[46px] rounded-lg px-5 text-[13px] font-semibold text-white hover:bg-[#24486e] disabled:opacity-55"
                  >
                    {busy ? 'Working…' : 'Invite'}
                  </button>
                </form>

                {sent && (
                  <div className="mt-3">
                    <Notice title={`Invitation created for ${sent.email}.`}>
                      <p>
                        Nothing has been emailed yet — that arrives with the mail sender. Send them
                        this link, which is good for a week and can be used once.
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code className="border-hair min-w-0 flex-1 truncate rounded-md border bg-white px-2 py-1.5 font-mono text-[11.5px]">
                          {inviteUrl(sent.token)}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard?.writeText(inviteUrl(sent.token))
                            setCopied(true)
                          }}
                          className="border-hair text-ink min-h-[38px] shrink-0 rounded-lg border bg-white px-3 text-[12.5px] font-semibold hover:bg-slate-50"
                        >
                          {copied ? 'Copied' : 'Copy link'}
                        </button>
                      </div>
                    </Notice>
                  </div>
                )}

                {invites?.length > 0 && (
                  <ul className="mt-4 list-none space-y-2 p-0">
                    {invites.map(i => (
                      <li
                        key={i.id}
                        className="border-hair flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                      >
                        <span className="min-w-0">
                          <b className="block truncate text-[13.5px]">{i.email}</b>
                          <span className="text-ink-soft text-[12px]">{daysLeft(i.expiresAt)}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => revoke(i.id)}
                          aria-label={`Revoke the invitation for ${i.email}`}
                          className="text-ink-soft hover:text-fail shrink-0 rounded-lg p-2"
                        >
                          <IconTrash size={18} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {invites?.length === 0 && (
                  <p className="text-ink-soft mt-3 text-[13px]">No invitations outstanding.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The roster: every account in every team you administer
// ─────────────────────────────────────────────────────────────────────────────

function MemberRow({ member, teams, isOwnerOf, isSelf, onChanged, onProblem }) {
  const [confirming, setConfirming] = useState(null) // 'remove' | 'move'
  const [moveTo, setMoveTo] = useState('')
  const [busy, setBusy] = useState(false)

  // Ownership is not a role you can pick. It moves through transfer_ownership
  // and nothing else, so the owner's row shows a label rather than a control.
  const editable = isOwnerOf && !isSelf && member.role !== 'owner'
  const elsewhere = teams.filter(t => t.id !== member.teamId && t.role === 'owner')

  const run = async (fn, after) => {
    setBusy(true)
    try {
      await fn()
      setConfirming(null)
      await after()
    } catch (e) {
      onProblem(e.message)
      setBusy(false)
    }
  }

  return (
    <>
      <tr className="border-hair border-t align-middle">
        <td className="max-w-[1px] truncate px-3 py-3 text-[13.5px]">{member.email}</td>
        <td className="text-ink-soft px-3 py-3 text-[13.5px]">{member.teamName}</td>
        <td className="px-3 py-3">
          {editable ? (
            <select
              value={member.role}
              aria-label={`Role for ${member.email}`}
              onChange={e =>
                run(() => setMemberRole(member.teamId, member.userId, e.target.value), onChanged)
              }
              disabled={busy}
              className="border-hair rounded-lg border bg-white px-2 py-1.5 text-[13px]"
            >
              <option value="admin">Admin</option>
              <option value="member">Member</option>
            </select>
          ) : (
            <RoleBadge role={member.role} />
          )}
        </td>
        <td className="px-3 py-3 text-right whitespace-nowrap">
          {editable && (
            <>
              {elsewhere.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMoveTo(elsewhere[0].id)
                    setConfirming('move')
                  }}
                  className="border-hair text-ink mr-2 min-h-[38px] rounded-lg border px-3 text-[12.5px] font-semibold hover:bg-slate-50"
                >
                  Move
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirming('remove')}
                aria-label={`Remove ${member.email} from ${member.teamName}`}
                className="text-ink-soft hover:text-fail rounded-lg p-2 align-middle"
              >
                <IconTrash size={18} />
              </button>
            </>
          )}
        </td>
      </tr>

      {confirming === 'remove' && (
        <tr>
          <td colSpan={4} className="p-0">
            <ConfirmDialog
              title={`Remove ${member.email} from ${member.teamName}?`}
              confirmLabel="Remove"
              cancelLabel="Keep them"
              danger
              onCancel={() => setConfirming(null)}
              onConfirm={() => run(() => removeMember(member.teamId, member.userId), onChanged)}
            >
              Their account stays, and so does everything they recorded — clients, visits and
              reports belong to the team, not to the person who entered them. They simply stop
              being able to see this team. Invite them again to undo it.
            </ConfirmDialog>
          </td>
        </tr>
      )}

      {confirming === 'move' && (
        <tr>
          <td colSpan={4} className="p-0">
            <ConfirmDialog
              title={`Move ${member.email} to another team?`}
              confirmLabel="Move"
              cancelLabel="Cancel"
              onCancel={() => setConfirming(null)}
              onConfirm={() =>
                run(() => moveMember(member.userId, member.teamId, moveTo), onChanged)
              }
            >
              <label className="block">
                <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">
                  Move to
                </span>
                <select
                  value={moveTo}
                  onChange={e => setMoveTo(e.target.value)}
                  className="border-hair w-full rounded-lg border bg-white px-3 py-2.5 text-[14px]"
                >
                  {elsewhere.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-3">
                They arrive as a member, whatever they are here — admin is granted inside one team
                and does not travel. Their work stays with {member.teamName}, and they lose sight of
                it.
              </p>
            </ConfirmDialog>
          </td>
        </tr>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export default function Teams() {
  const { session, user } = useAuth()
  const { teams, team, isAdmin, refresh, createTeam, setActiveTeam } = useTeam()
  const [members, setMembers] = useState([])
  const [problem, setProblem] = useState('')
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [creating, setCreating] = useState(false)

  const onProblem = useCallback(message => setProblem(message), [])

  const loadMembers = useCallback(async () => {
    if (!session) return
    try {
      setMembers(await listAllMembers())
    } catch (e) {
      setProblem(e.message)
    }
  }, [session])

  useEffect(() => {
    loadMembers()
  }, [loadMembers])

  const reload = useCallback(async () => {
    await Promise.all([refresh(), loadMembers()])
  }, [refresh, loadMembers])

  // Nothing here exists without an account: teams, roles and invitations are
  // all server-side. Local mode is a single device with its own data.
  if (!session) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Notice title="Teams need an account.">
          This build is running on local storage, where the data belongs to this device alone and
          there is nobody to share it with. Sign in to create teams and invite colleagues.
        </Notice>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Notice blocked title="Only an owner or admin can manage teams.">
          You are a member of {team?.name}. Whoever owns it can change that from this page.
        </Notice>
      </div>
    )
  }

  async function create(e) {
    e.preventDefault()
    setCreating(true)
    setProblem('')
    const { error } = await createTeam(newName.trim(), newDescription.trim())
    setCreating(false)
    if (error) {
      setProblem(error.message)
      return
    }
    setNewName('')
    setNewDescription('')
    await loadMembers()
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 p-6">
      {problem && (
        <Notice blocked title={problem}>
          <button
            type="button"
            onClick={() => setProblem('')}
            className="text-navy font-semibold underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </Notice>
      )}

      <section>
        <h2 className="text-[19px] font-bold tracking-[-.01em]">Your teams</h2>
        <p className="text-ink-soft mt-1 max-w-[68ch] text-[14px]">
          Every client, visit and report belongs to one team. You work in one at a time — switching
          changes what the rest of the app shows you, and nothing else.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {teams.map(t => (
            <TeamCard
              key={t.id}
              team={t}
              active={t.id === team?.id}
              onSwitch={setActiveTeam}
              onChanged={reload}
              onProblem={onProblem}
            />
          ))}
        </div>
      </section>

      <section className="border-hair rounded-xl border bg-white p-6">
        <h2 className="text-[19px] font-bold tracking-[-.01em]">Create a team</h2>
        <p className="text-ink-soft mt-1 max-w-[62ch] text-[14px]">
          A new team starts empty — its own clients, its own test lists, its own branding. You own
          it, and can invite people to it once it exists.
        </p>
        <form onSubmit={create} className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Team name"
            value={newName}
            onChange={setNewName}
            required
            placeholder="e.g. Merge Tech"
          />
          <Field
            label="Description"
            value={newDescription}
            onChange={setNewDescription}
            placeholder="Optional — what this team covers"
          />
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="bg-navy min-h-[46px] rounded-lg px-5 text-[13.5px] font-semibold text-white hover:bg-[#24486e] disabled:opacity-55"
            >
              {creating ? 'Creating…' : 'Create team'}
            </button>
          </div>
        </form>
      </section>

      <section className="border-hair rounded-xl border bg-white p-6">
        <h2 className="text-[19px] font-bold tracking-[-.01em]">Accounts</h2>
        <p className="text-ink-soft mt-1 max-w-[62ch] text-[14px]">
          Everyone in the teams you administer. Role, removal and moving are the owner's alone —
          an admin sees the list but cannot change who is on it.
        </p>

        <div className="mt-4 -mx-2 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="text-ink-soft text-[12.5px] font-semibold">
                <th className="px-3 pb-2">Account</th>
                <th className="px-3 pb-2">Team</th>
                <th className="px-3 pb-2">Role</th>
                <th className="px-3 pb-2" />
              </tr>
            </thead>
            <tbody>
              {members.map(m => (
                <MemberRow
                  key={`${m.teamId}:${m.userId}`}
                  member={m}
                  teams={teams}
                  isOwnerOf={teams.find(t => t.id === m.teamId)?.role === 'owner'}
                  isSelf={m.userId === user?.id}
                  onChanged={reload}
                  onProblem={onProblem}
                />
              ))}
            </tbody>
          </table>
        </div>

        {members.length === 0 && (
          <p className="text-ink-soft mt-3 text-[13px]">
            Nobody but you yet. Invite someone from the team above.
          </p>
        )}
      </section>
    </div>
  )
}
