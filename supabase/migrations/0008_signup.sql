-- Pemcora — signing up, and closing the older functions to signed-out callers
-- (build plan, step B5). Run in the Supabase SQL editor after 0007. Safe to re-run.
--
-- Select nothing before running: the editor executes only the highlighted text
-- if anything is selected, which silently runs a fragment of this file.
--
-- Apply this BEFORE the app that uses it goes live: its sign-up screen calls the
-- create_organisation() below. Nothing already live depends on what it closes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What this does
-- ─────────────────────────────────────────────────────────────────────────────
--
--   teams.state          which state a new electrical team is in. When a state's
--                        own pack is released, its teams on electrical_general
--                        get it free (2.3), and nothing recorded that until now.
--   teams.addons_wanted  add-ons picked at sign-up, noted until billing exists.
--                        Step E1 connects them to checkout.
--   team_entitlements()  also says which pack is the starter and whether it has
--                        been used, which decides whether it can still be swapped.
--   visit_exports        only an owner or admin can delete a report record.
--   anon                 can no longer run ten older functions, and nobody can run
--                        two trigger functions directly.

-- ─────────────────────────────────────────────────────────────────────────────
-- What a team said at sign-up
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The column lock from 0006 still holds: `authenticated` can update a team's name
-- and description and nothing else, so only the function below writes these.

alter table public.teams add column if not exists state text;
alter table public.teams add column if not exists addons_wanted text[] not null default '{}';

alter table public.teams drop constraint if exists teams_state_known;
alter table public.teams add constraint teams_state_known
  check (state is null or state in ('NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'));

/**
 * What the sign-up screen calls: 0006's create_organisation(), and what else the
 * team said, in one transaction, so a team can't exist without it.
 *
 * Its own overload with no defaults, not a new version of that one. A call with
 * up to four arguments still means 0006's, and re-running 0006 can't make two
 * functions that a call could mean either of.
 *
 * Add-ons are only noted, so one that doesn't exist, or is already the starter,
 * is dropped rather than refused. A team that doesn't inspect has none.
 */
create or replace function public.create_organisation(
  p_name         text,
  p_account_type text,
  p_pack_id      text,
  p_description  text,
  p_state        text,
  p_addons       text[]
)
returns public.teams language plpgsql security definer set search_path = public as $$
declare v_team public.teams;
begin
  v_team := public.create_organisation(p_name, p_account_type, p_pack_id, p_description);

  update public.teams
     set state = nullif(btrim(coalesce(p_state, '')), ''),
         -- With no pack, `<> p_pack_id` is never true, so a landlord notes none.
         addons_wanted = coalesce((
           select array_agg(p.id order by p.id)
             from public.packs p
            where p.id = any(p_addons) and p.id <> 'core' and p.id <> p_pack_id
         ), '{}')
   where id = v_team.id
   returning * into v_team;

  return v_team;
end;
$$;

revoke execute on function public.create_organisation(text, text, text, text, text, text[]) from public, anon;
grant  execute on function public.create_organisation(text, text, text, text, text, text[]) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Whether the starter pack can still be swapped
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0006's function with two more fields. A team with no starter (a landlord, or a
-- team whose pack was granted free) answers null and false. The app only uses these
-- to decide what to offer: choose_starter_pack() is still what decides.

create or replace function public.team_entitlements(p_team_id uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select case when not public.is_team_member(p_team_id) then null else jsonb_build_object(
    'enforced',     public.limits_enforced(),
    'account_type', (select t.account_type from public.teams t where t.id = p_team_id),
    'plan',         coalesce((select s.plan from public.subscriptions s where s.team_id = p_team_id), 'free'),
    'is_pro',       public.team_is_pro(p_team_id),
    'seat_limit',   public.team_seat_limit(p_team_id),
    'seats_used',   (select count(*) from public.team_members m where m.team_id = p_team_id),
    'visit_limit',  public.team_visit_limit(p_team_id),
    'visits_used',  coalesce((
                      select u.visits_started from public.team_usage u
                       where u.team_id = p_team_id
                         and u.period = date_trunc('month', public.local_day(now()))::date
                    ), 0),
    'packs',        '["core"]'::jsonb || coalesce((
                      select jsonb_agg(p.pack_id order by p.pack_id)
                        from public.team_packs p where p.team_id = p_team_id
                    ), '[]'::jsonb),
    'past_due_until', (select s.past_due_since + interval '7 days' from public.subscriptions s
                        where s.team_id = p_team_id and s.status = 'past_due'),
    'cancel_at',      (select s.cancel_at from public.subscriptions s where s.team_id = p_team_id),
    'import_used',    (select t.import_used_at is not null from public.teams t where t.id = p_team_id),
    'open_visits',    (select count(*) from public.visits v
                        where v.team_id = p_team_id and v.completed_at is null),
    'starter_pack',   (select p.pack_id from public.team_packs p
                        where p.team_id = p_team_id and p.source = 'starter'),
    'starter_in_use', coalesce((select public.pack_in_use(p.team_id, p.pack_id) from public.team_packs p
                                 where p.team_id = p_team_id and p.source = 'starter'), false)
  ) end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Report records
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A record of what went out to a client, which the screens only let an owner or
-- admin delete. Restrictive, so it holds alongside 0007's visit_exports_all, which
-- gives members everything else: they still file and re-stamp reports. A re-run of
-- 0007 puts that policy back and this still holds. Deleting a visit still takes its
-- records with it, because a foreign key's cascade doesn't go through policies.

drop policy if exists visit_exports_delete_admins on public.visit_exports;
create policy visit_exports_delete_admins on public.visit_exports
  as restrictive for delete to authenticated
  using (public.is_team_admin(team_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- Closing the older functions to signed-out callers
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Each of these already refuses a signed-out caller inside, so this is the second
-- lock. A function starts out open to everyone through PUBLIC as well as to anon by
-- name, so revoking from anon alone would change nothing.
--
-- Left open, for pages used before signing in: email_is_registered, invite_preview,
-- report_preview and reminder_opt_out. Every policy is `to authenticated`, and those
-- four run as their owner, so no signed-out page starts failing.

revoke execute on function public.all_members_overview()                          from public, anon;
revoke execute on function public.create_team(text, text)                         from public, anon;
revoke execute on function public.is_team_admin(uuid)                             from public, anon;
revoke execute on function public.is_team_member(uuid)                            from public, anon;
revoke execute on function public.is_team_owner(uuid)                             from public, anon;
revoke execute on function public.move_member(uuid, uuid, uuid)                   from public, anon;
revoke execute on function public.my_teams()                                      from public, anon;
revoke execute on function public.set_member_role(uuid, uuid, text)               from public, anon;
revoke execute on function public.team_members_list(uuid)                         from public, anon;
revoke execute on function public.transfer_ownership(uuid, uuid)                  from public, anon;

grant  execute on function public.all_members_overview()                          to authenticated;
grant  execute on function public.create_team(text, text)                         to authenticated;
grant  execute on function public.is_team_admin(uuid)                             to authenticated;
grant  execute on function public.is_team_member(uuid)                            to authenticated;
grant  execute on function public.is_team_owner(uuid)                             to authenticated;
grant  execute on function public.move_member(uuid, uuid, uuid)                   to authenticated;
grant  execute on function public.my_teams()                                      to authenticated;
grant  execute on function public.set_member_role(uuid, uuid, text)               to authenticated;
grant  execute on function public.team_members_list(uuid)                         to authenticated;
grant  execute on function public.transfer_ownership(uuid, uuid)                  to authenticated;

-- Trigger functions, which nothing should call directly. A trigger still fires: the
-- privilege is only checked when the trigger is created.
revoke execute on function public.consume_invite_on_confirm() from public, anon, authenticated;
revoke execute on function public.set_updated_at()            from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification
-- ─────────────────────────────────────────────────────────────────────────────

-- anon_can_call must be exactly: email_is_registered, invite_preview,
-- reminder_opt_out, report_preview. The rest must all be 1.
select
  (select string_agg(p.proname, ', ' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'execute')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')) as anon_can_call,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'teams' and column_name = 'state')         as col_state,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'teams' and column_name = 'addons_wanted') as col_addons,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_organisation' and p.pronargs = 6)       as fn_sign_up,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'visit_exports'
      and policyname = 'visit_exports_delete_admins' and permissive = 'RESTRICTIVE')           as policy_exports;
