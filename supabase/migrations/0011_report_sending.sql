-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 — sending reports: a daily cap, and nothing unfinished goes out
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Build plan D2. Two rules send_report() (0007) didn't have:
--
--   A daily cap. The deliver-report Edge Function emails whatever send_report()
--   and resend_report() hand it, from Pemcora's own address, to any address
--   the sender types. With no limit, any account could send unlimited email
--   from Pemcora's domain (Phase A security review). A team may send 10
--   reports in any 24 hours on Free and 50 on Pro (M.D., 6 November), and
--   "Send again" counts, since it emails too. Not tied to enforce_limits: it
--   guards Pemcora's email, not the plans, so it holds from the day it's
--   applied. Refused with SQLSTATE PT429 and hint 'send_cap'.
--
--   Nothing unfinished. A sent report can't be edited, so a fail whose note
--   still says [timeframe] must not reach one. The app refuses first; this is
--   the rule it answers to. The snapshot marks such a fail `unfinished`
--   (src/lib/reportSnapshot.js). Refused with hint 'unfinished'.
--
-- Every send and every "Send again" is logged in report_sends, which only these
-- functions read or write. Withdrawing a report doesn't take its send back.
--
-- Replaces send_report() and resend_report() with 0007's own bodies plus these
-- checks. Re-running 0007 by itself puts back the versions without them, so
-- re-run 0011 after it.
--
-- Safe to re-run. Applied by M.D. in the Supabase SQL editor, after 0010.

create table if not exists public.report_sends (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  delivery_id uuid references public.report_deliveries(id) on delete set null,
  sent_at     timestamptz not null default now()
);
create index if not exists report_sends_team_idx on public.report_sends(team_id, sent_at);

alter table public.report_sends enable row level security;
revoke all on table public.report_sends from anon, authenticated;

-- How many reports a team may send in any 24 hours.
create or replace function public.report_send_cap(_team_id uuid)
returns int language sql security definer stable set search_path = public as $$
  select case when public.team_is_pro(_team_id) then 50 else 10 end;
$$;

-- Refuses a send that would go over the team's cap, then counts it. The team's
-- row is locked first, so two sends at the same moment can't both slip under.
create or replace function public._count_report_send(_team_id uuid, _delivery_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cap  int := public.report_send_cap(_team_id);
  v_sent int;
begin
  perform 1 from public.teams where id = _team_id for update;
  select count(*) into v_sent
    from public.report_sends
   where team_id = _team_id and sent_at > now() - interval '24 hours';
  if v_sent >= v_cap then
    raise exception 'Your team has sent its % reports for the last 24 hours. Try again later.', v_cap
      using errcode = 'PT429', hint = 'send_cap';
  end if;
  insert into public.report_sends (team_id, delivery_id) values (_team_id, _delivery_id);
end;
$$;

-- Whether a snapshot has a fail whose note still waits for its timeframe, in the
-- whole-site part or any room.
create or replace function public._snapshot_unfinished(p_snapshot jsonb)
returns boolean language sql immutable set search_path = public as $$
  select exists (
           select 1 from jsonb_array_elements(coalesce(p_snapshot -> 'site' -> 'failed', '[]'::jsonb)) f
            where (f ->> 'unfinished')::boolean)
      or exists (
           select 1
             from jsonb_array_elements(coalesce(p_snapshot -> 'rooms', '[]'::jsonb)) r,
                  jsonb_array_elements(coalesce(r -> 'failed', '[]'::jsonb)) f
            where (f ->> 'unfinished')::boolean);
$$;

/**
 * 0007's send_report(), with the cap and the [timeframe] check (D2).
 */
create or replace function public.send_report(
  p_visit_id        uuid,
  p_recipient_email text,
  p_snapshot        jsonb default '{}'::jsonb,
  p_file_path       text  default null
)
returns public.report_deliveries language plpgsql security definer set search_path = public, auth as $$
declare
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_visit public.visits;
  v_loc   public.locations;
  v_team  public.teams;
  v_co    jsonb;
  v_row   public.report_deliveries;
  v_link  public.site_links;
begin
  select * into v_visit from public.visits where id = p_visit_id;
  if v_visit.id is null or not public.is_team_member(v_visit.team_id) then
    raise exception 'That visit is not in your team';
  end if;
  if v_visit.completed_at is null then
    raise exception 'Complete the visit before sending its report';
  end if;
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'That is not an email address';
  end if;
  -- The file must be one this team uploaded, never somebody else's.
  if p_file_path is not null and public.path_team(p_file_path) is distinct from v_visit.team_id then
    raise exception 'A report file has to be in your own team''s folder';
  end if;
  -- D2: a sent report can't be edited, so it can't go with a note left unfinished.
  if public._snapshot_unfinished(p_snapshot) then
    raise exception 'A note in this report still says [timeframe]. Fill it in before sending.'
      using errcode = 'check_violation', hint = 'unfinished';
  end if;

  -- The visit's own team's site, never another team's (rows written before
  -- the parent checks in the RLS section existed are not trusted either).
  select * into v_loc  from public.locations
   where id = v_visit.location_id and team_id = v_visit.team_id;
  if v_loc.id is null then raise exception 'That visit''s site is not in your team'; end if;
  select * into v_team from public.teams     where id = v_visit.team_id;
  select company into v_co from public.team_settings where team_id = v_visit.team_id;

  insert into public.report_deliveries (
    provider_team_id, visit_id, provider_location_id, workflow_id, completed_on, outcome,
    site, snapshot, file_path, recipient_email, sent_by
  ) values (
    v_visit.team_id, v_visit.id, v_visit.location_id, v_visit.kind,
    public.local_day(v_visit.completed_at), v_visit.outcome,
    jsonb_build_object(
      'address',  v_loc.address, 'suburb', v_loc.suburb, 'city', v_loc.city,
      'state',    v_loc.state,   'postcode', v_loc.postcode),
    -- Written over whatever the app sent under the same keys, so neither the
    -- provider nor the signature on a report can be supplied by the client.
    coalesce(p_snapshot, '{}'::jsonb) || jsonb_build_object(
      'provider', jsonb_build_object(
        'team_id', v_team.id, 'name', v_team.name, 'company', coalesce(v_co, '{}'::jsonb)),
      'signoff', v_visit.signoff),
    p_file_path, v_email, auth.uid()
  )
  returning * into v_row;

  -- D2: counted, or refused over the cap, which undoes the insert above.
  perform public._count_report_send(v_visit.team_id, v_row.id);

  -- A site this same person has filed before goes straight into the same
  -- property. Matched on their address being in that team, so a link made by a
  -- previous owner of the house never files a report into the wrong account.
  select l.* into v_link
    from public.site_links l
    join public.team_members m on m.team_id = l.recipient_team_id
    join auth.users u on u.id = m.user_id
   where l.provider_location_id = v_visit.location_id
     and lower(u.email) = v_email
   limit 1;

  if v_link.recipient_team_id is not null then
    v_row := public._file_delivery(v_row.id, v_link.recipient_team_id, v_link.recipient_location_id, null);
  end if;

  return v_row;
end;
$$;

/**
 * 0007's resend_report(), counted against the cap (D2): it emails too.
 */
create or replace function public.resend_report(p_delivery_id uuid)
returns public.report_deliveries language plpgsql security definer set search_path = public as $$
declare v_row public.report_deliveries;
begin
  select * into v_row from public.report_deliveries where id = p_delivery_id for update;
  if v_row.id is null or not public.is_team_member(v_row.provider_team_id) then
    raise exception 'That report was not sent by your team';
  end if;

  perform public._count_report_send(v_row.provider_team_id, v_row.id);

  update public.report_deliveries
     set token = gen_random_uuid(), link_expires_at = now() + interval '90 days'
   where id = p_delivery_id
   returning * into v_row;

  return v_row;
end;
$$;

-- The helpers are for these two functions only.
revoke execute on function public.report_send_cap(uuid)              from public, anon, authenticated;
revoke execute on function public._count_report_send(uuid, uuid)     from public, anon, authenticated;
revoke execute on function public._snapshot_unfinished(jsonb)        from public, anon, authenticated;
revoke execute on function public.send_report(uuid, text, jsonb, text) from public, anon;
revoke execute on function public.resend_report(uuid)                  from public, anon;
grant  execute on function public.send_report(uuid, text, jsonb, text) to authenticated;
grant  execute on function public.resend_report(uuid)                  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — send_capped and resend_capped true, sends_closed true, and
-- helpers_callable 0.
-- ─────────────────────────────────────────────────────────────────────────────

select
  position('_count_report_send' in pg_get_functiondef('public.send_report(uuid, text, jsonb, text)'::regprocedure)) > 0
                                                                                           as send_capped,
  position('_count_report_send' in pg_get_functiondef('public.resend_report(uuid)'::regprocedure)) > 0
                                                                                           as resend_capped,
  not has_table_privilege('authenticated', 'public.report_sends', 'select')                as sends_closed,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('report_send_cap', '_count_report_send', '_snapshot_unfinished')
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute')))                           as helpers_callable;
