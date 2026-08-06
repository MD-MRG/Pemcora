// Proves the Row-Level Security in supabase/migrations/0001_init.sql actually
// holds, from a real client with real sessions — the one thing the SQL editor
// cannot tell you, because it runs as a superuser with RLS bypassed.
//
//   node tests/rls.mjs
//
// Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from .env. Creates three
// throwaway accounts and two teams, asserts, then deletes both teams. The
// auth.users rows survive — removing those needs the service_role key, which
// deliberately is not here. tests/README.md has the SQL to clear them.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const URL_ = env.VITE_SUPABASE_URL
const KEY = env.VITE_SUPABASE_ANON_KEY
if (!URL_ || !KEY) {
  console.error('FAIL  .env is missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

let failures = 0
const log = (ok, name, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

const fresh = () => createClient(URL_, KEY, { auth: { persistSession: false } })

// Plus-aliases on the project's own address. Supabase validates the domain, so
// example.com and other throwaway domains are rejected outright; a real one that
// resolves is required. Nothing is ever delivered to these while "Confirm email"
// is off, and the timestamp keeps re-runs from colliding with earlier users.
const INBOX = 'MDGhCode@gmail.com'
const stamp = Date.now()
const account = n => {
  const [local, domain] = INBOX.split('@')
  return {
    email: `${local}+rls-${stamp}-${n}@${domain}`,
    password: `Test-${stamp}-${n}!`,
  }
}

async function signUp(who) {
  const sb = fresh()
  const { data, error } = await sb.auth.signUp(who)
  if (error) throw new Error(`sign-up failed for ${who.email}: ${error.message}`)
  if (!data.session) {
    throw new Error(
      'sign-up returned no session — "Confirm email" is on for this project. ' +
        'Turn it off to run this suite, or confirm the addresses by hand.',
    )
  }
  return { sb, userId: data.user.id, email: who.email }
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nRLS check against ${URL_}\n`)

// anon — before any session exists at all.
{
  const sb = fresh()
  const { data, error } = await sb.from('clients').select('*')
  log(error !== null || (data ?? []).length === 0, 'anon cannot read clients', error?.code ?? 'empty')
  const t = await sb.from('teams').select('*')
  log(t.error !== null || (t.data ?? []).length === 0, 'anon cannot read teams', t.error?.code ?? 'empty')
}

const owner = await signUp(account('owner'))
const member = await signUp(account('member'))
const outsider = await signUp(account('outsider'))
console.log(`  accounts: ${owner.email} / ${member.email} / ${outsider.email}\n`)

// ── The owner's team ─────────────────────────────────────────────────────────

const created = await owner.sb.rpc('create_team', { p_name: 'RLS Test Team' })
log(!created.error && !!created.data?.id, 'owner creates a team', created.error?.message)
if (created.error) process.exit(1)
const team = created.data
const teamId = team.id

{
  const { data } = await owner.sb.rpc('my_teams')
  log(data?.[0]?.role === 'owner', 'creator is owner, not admin', data?.[0]?.role)
}

// This is the assertion that tells us whether 0002_grants.sql was ever run:
// without GRANT INSERT the row is refused with 42501 before RLS is consulted.
const clientIns = await owner.sb
  .from('clients')
  .insert({ team_id: teamId, name: `Acme ${stamp}` })
  .select()
  .single()
log(
  !clientIns.error,
  'owner can insert a client (proves table grants exist)',
  clientIns.error ? `${clientIns.error.code} ${clientIns.error.message}` : '',
)
const clientId = clientIns.data?.id

// ── The member joins ─────────────────────────────────────────────────────────

const joined = await member.sb.rpc('join_team', { p_invite_code: team.invite_code })
log(!joined.error, 'member joins with the invite code', joined.error?.message)

{
  const { data } = await member.sb.rpc('my_teams')
  log(data?.[0]?.role === 'member', 'joining always lands as member', data?.[0]?.role)
}

{
  const { data, error } = await member.sb.from('clients').select('*').eq('team_id', teamId)
  log(!error && data?.length === 1, 'member sees their own team\'s clients', error?.message)
}

// ── A member must not be able to promote themselves ──────────────────────────

{
  const { error } = await member.sb.rpc('set_member_role', {
    p_team_id: teamId,
    p_user_id: member.userId,
    p_role: 'admin',
  })
  log(!!error, 'member CANNOT promote themselves via set_member_role', error?.message ?? 'NO ERROR')
}

{
  const { error } = await member.sb.rpc('set_member_role', {
    p_team_id: teamId,
    p_user_id: member.userId,
    p_role: 'owner',
  })
  log(!!error, 'member CANNOT make themselves owner via set_member_role', error?.message ?? 'NO ERROR')
}

// The RPC is one lock; the table is the other. No UPDATE policy exists and the
// privilege is revoked, so this must not change a row either.
{
  const { data, error } = await member.sb
    .from('team_members')
    .update({ role: 'owner' })
    .eq('team_id', teamId)
    .eq('user_id', member.userId)
    .select()
  log(
    !!error || (data ?? []).length === 0,
    'member CANNOT patch team_members directly',
    error ? `${error.code} ${error.message}` : 'no rows updated',
  )
  const check = await member.sb.rpc('my_teams')
  log(check.data?.[0]?.role === 'member', 'member is still a member afterwards', check.data?.[0]?.role)
}

// A member must not be able to remove the owner and take the team.
{
  const { data, error } = await member.sb
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', owner.userId)
    .select()
  log(!!error || (data ?? []).length === 0, 'member CANNOT remove the owner', error?.message ?? 'no rows deleted')
}

// Shared settings are admin-only to write, readable to all.
{
  const read = await member.sb.from('team_settings').select('*').eq('team_id', teamId)
  log(!read.error && read.data?.length === 1, 'member can read team settings', read.error?.message)
  const write = await member.sb
    .from('team_settings')
    .update({ plate: 'espresso' })
    .eq('team_id', teamId)
    .select()
  log((write.data ?? []).length === 0 || !!write.error, 'member CANNOT change team settings', write.error?.message ?? 'no rows updated')
}

// ── The owner CAN do what the member cannot ──────────────────────────────────

{
  const { error } = await owner.sb.rpc('set_member_role', {
    p_team_id: teamId,
    p_user_id: member.userId,
    p_role: 'admin',
  })
  log(!error, 'owner CAN promote a member to admin', error?.message)
  const check = await member.sb.rpc('my_teams')
  log(check.data?.[0]?.role === 'admin', 'the promotion took effect', check.data?.[0]?.role)
}

// Even a promoted admin must not be able to mint an owner or demote one.
{
  const { error } = await member.sb.rpc('set_member_role', {
    p_team_id: teamId,
    p_user_id: owner.userId,
    p_role: 'member',
  })
  log(!!error, 'admin CANNOT demote the owner', error?.message ?? 'NO ERROR')
}

// ── A different team must see nothing of this one ────────────────────────────

const other = await outsider.sb.rpc('create_team', { p_name: 'Other Team' })
log(!other.error, 'outsider creates their own team', other.error?.message)

// Two separate properties, deliberately not conflated. Zero rows is the
// security guarantee; a clean read is the health check. A privilege failure
// satisfies the first and fails the second, and reporting that as one line
// reads as "data leaked" when the opposite is true.
{
  const { data, error } = await outsider.sb.from('clients').select('*')
  log((data ?? []).length === 0, "outsider sees NONE of the other team's clients", `${data?.length ?? 0} rows`)
  log(!error, 'outsider can query clients at all (grants exist)', error ? `${error.code} ${error.message}` : '')
}

{
  const { data } = await outsider.sb.from('clients').select('*').eq('id', clientId)
  log((data ?? []).length === 0, 'outsider cannot fetch that client by id even knowing it', `${data?.length ?? 0} rows`)
}

{
  const { data } = await outsider.sb.from('teams').select('*').eq('id', teamId)
  log((data ?? []).length === 0, "outsider cannot read the other team's row", `${data?.length ?? 0} rows`)
}

{
  const { data } = await outsider.sb.from('team_members').select('*').eq('team_id', teamId)
  log((data ?? []).length === 0, "outsider cannot list the other team's members", `${data?.length ?? 0} rows`)
}

{
  const { error } = await outsider.sb.rpc('team_members_list', { p_team_id: teamId })
  const { data } = await outsider.sb.rpc('team_members_list', { p_team_id: teamId })
  log(!!error || (data ?? []).length === 0, 'team_members_list refuses a non-member', error?.message ?? 'empty')
}

// Writing into someone else's team must be refused by the WITH CHECK clause.
{
  const { error } = await outsider.sb.from('clients').insert({ team_id: teamId, name: 'Injected' })
  log(!!error, "outsider CANNOT insert into the other team", error?.code ?? 'NO ERROR')
}

// ── Clean up the teams (cascades to every row beneath them) ──────────────────

{
  const { error } = await owner.sb.from('teams').delete().eq('id', teamId)
  log(!error, 'owner deletes the test team', error?.message)
  const { error: e2 } = await outsider.sb.from('teams').delete().eq('id', other.data.id)
  log(!e2, 'outsider deletes their test team', e2?.message)
}

console.log(
  `\n${failures === 0 ? 'All assertions passed.' : `${failures} assertion(s) FAILED.`}\n` +
    `Leftover auth users: ${owner.email}, ${member.email}, ${outsider.email}\n`,
)
process.exit(failures === 0 ? 0 : 1)
