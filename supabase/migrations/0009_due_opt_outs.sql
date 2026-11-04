-- ─────────────────────────────────────────────────────────────────────────────
-- 0009 — which of a team's checks its clients said are no longer needed
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Build plan C4. The Due page shows the checks a client marked "no longer
-- needed" from a reminder email. It has to take that from the opt-out list
-- (reminder_opted_out()), not from the check's own switch: a team can make that
-- read "on" again by re-creating the check while the contact's email is blank.
--
-- The opt-out list and reminder_opted_out() stay closed to signed-in users
-- (0007): the list holds the emails and addresses of every team's clients, and
-- the function answers for any team. This opens one narrow view of it: for one
-- team, to its own members, which of its checks are opted out and since when.
-- Nothing about who opted out, or anything another team's clients did.
--
-- SECURITY DEFINER, because the rule it answers with is closed to the caller;
-- it checks membership itself before answering anything.
--
-- Safe to re-run. Applied by M.D. in the Supabase SQL editor, after 0008.

create or replace function public.due_opt_outs(p_team_id uuid)
returns table (
  item_id      uuid,
  location_id  uuid,
  obligation   text,
  opted_out_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select ci.id, ci.location_id, ci.obligation, o.at
    from public.compliance_items ci
    cross join lateral (
      select public.reminder_opted_out(ci.team_id, ci.location_id, ci.obligation) as at
    ) o
   where ci.team_id = p_team_id
     and public.is_team_member(p_team_id)
     and o.at is not null
   order by ci.location_id, ci.obligation;
$$;

revoke execute on function public.due_opt_outs(uuid) from public, anon;
grant  execute on function public.due_opt_outs(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — fn_definer and members_can_call should be 1, anon_can_call
-- false, and rule_still_closed true.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'due_opt_outs' and p.prosecdef)          as fn_definer,
  has_function_privilege('authenticated', 'public.due_opt_outs(uuid)', 'execute')::int  as members_can_call,
  has_function_privilege('anon', 'public.due_opt_outs(uuid)', 'execute')                 as anon_can_call,
  has_function_privilege('authenticated', 'public.reminder_opted_out(uuid, uuid, text)', 'execute') = false
                                                                                          as rule_still_closed;
