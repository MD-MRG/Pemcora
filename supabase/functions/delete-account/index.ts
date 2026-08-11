/**
 * delete-account — destroy somebody's Pemcora login for good.
 *
 * Deploy with `supabase functions deploy delete-account`. No secrets to set:
 * the service-role key it needs is provided by the platform.
 *
 * This is the one thing on the Teams page the browser genuinely cannot do.
 * Removing somebody from a team is a row deletion under RLS; deleting the
 * account behind it is an admin-API call, which needs the service-role key,
 * which must never reach a browser.
 *
 * Three guards, and the last one is the important one:
 *
 *   1. The caller has to own the team the target is in. Not admin — owner.
 *   2. The target must not own a team. Their team would be left with no owner
 *      and no way to appoint one, since only an owner can transfer ownership.
 *   3. The target must not be in any other team. An account is a person, not a
 *      membership: deleting one because you no longer want them in your team
 *      would also throw them out of somebody else's, and that is not your call
 *      to make. When this bites, removing them from your team is the answer,
 *      and the app says so.
 *
 * What survives: everything they recorded. Clients, visits and reports are keyed
 * on the team, and `created_by` is ON DELETE SET NULL, so the work stays and
 * only the attribution goes.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { json, preflight } from '../_shared/cors.ts'

Deno.serve(async req => {
  const pre = preflight(req)
  if (pre) return pre

  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'Not authenticated' }, 401)

  let body: { userId?: string; teamId?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Expected a JSON body' }, 400)
  }
  const { userId, teamId } = body
  if (!userId || !teamId) return json({ error: 'Expected userId and teamId' }, 400)

  const caller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authorization } } },
  )

  const { data: auth } = await caller.auth.getUser()
  const callerId = auth?.user?.id
  if (!callerId) return json({ error: 'Not authenticated' }, 401)
  if (callerId === userId) {
    return json({ error: 'You cannot delete your own account from here.' }, 400)
  }

  // my_teams reads as the caller, so this is their real role and not a claim
  // taken from the request.
  const { data: mine, error: minesError } = await caller.rpc('my_teams')
  if (minesError) return json({ error: minesError.message }, 400)
  const owned = (mine ?? []).find((t: { team_id: string }) => t.team_id === teamId)
  if (!owned || owned.role !== 'owner') {
    return json({ error: 'Only the owner of that team can delete an account in it.' }, 403)
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: memberships, error: mErr } = await admin
    .from('team_members')
    .select('team_id, role, teams(name)')
    .eq('user_id', userId)
  if (mErr) return json({ error: mErr.message }, 400)

  if (!memberships?.some(m => m.team_id === teamId)) {
    return json({ error: 'That person is not in that team.' }, 400)
  }
  if (memberships.some(m => m.role === 'owner')) {
    return json(
      { error: 'They own a team, and a team cannot be left without an owner. Transfer it first.' },
      400,
    )
  }
  const others = memberships.filter(m => m.team_id !== teamId)
  if (others.length) {
    const names = others
      .map(m => (m.teams as { name?: string } | null)?.name)
      .filter(Boolean)
      .join(', ')
    return json(
      {
        error: `They are also in ${names || 'another team'}, so deleting the account is not yours to do. Remove them from this team instead.`,
      },
      400,
    )
  }

  const { error: delError } = await admin.auth.admin.deleteUser(userId)
  if (delError) return json({ error: delError.message }, 400)

  return json({ deleted: true })
})
