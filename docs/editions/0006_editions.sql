-- Pemcora — editions: one app, several trades, and a free tier the database enforces.
-- Run in the Supabase SQL editor after 0005_teams_and_invites.sql. Safe to re-run.
--
-- Select nothing before running: the editor executes only the highlighted text
-- if anything is selected, which silently runs a fragment of this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What changes, and what deliberately does not
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Pemcora stops being an AV-only console and becomes one app sold as editions:
-- AV maintenance, Victorian rental safety checks, Queensland smoke alarms, with
-- room for more. Each edition is a PACK of WORKFLOWS. A workflow is what
-- `visits.kind` and `team_templates.kind` already were — maintenance,
-- commissioning, custom — so the existing three simply become the first rows of
-- a catalogue instead of a hard-coded CHECK list.
--
-- Nothing is renamed or dropped. Every team that exists when this first runs is
-- grandfathered: Pro, unlimited seats and inspections, the AV pack switched on.
-- The app as it is today keeps working without a single code change.
--
-- And nothing bites until you say so. The limits ship switched OFF: they count
-- and report, but refuse nothing, until the day billing goes live and you run
--
--     update public.app_settings set enforce_limits = true;
--
-- Until then a new sign-up has no way to pay, and tests/rls.mjs joins a second
-- person to a brand-new team — both would hit a one-seat Free plan otherwise.
--
-- Why the paywall lives here and not in React: Pemcora is a static site with the
-- publishable key inside the bundle. Anything the UI hides, the REST API still
-- answers to whoever asks it directly. So every limit below — packs, seats,
-- inspections per month — is checked by Postgres at the moment of the write,
-- and the UI's job is only to explain it before somebody hits it.
--
-- Billing state (subscriptions, add-on packs) has no write policy at all. It is
-- written by the Stripe webhook with the service_role key, which never leaves
-- the server. No client can make its own team Pro.
--
-- Limit errors are raised with SQLSTATE PT402, which PostgREST turns into HTTP
-- 402 Payment Required, and hint 'upgrade'. The app can tell "you need to
-- upgrade" apart from every other failure without parsing the message.

-- ─────────────────────────────────────────────────────────────────────────────
-- Catalogue: packs, and the workflows each one unlocks
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Identifiers and the facts the server needs, nothing more. Test lists stay in
-- src/data/ exactly as before — duplicating them here would guarantee the two
-- drift the first time a list is edited (see templateStore.js).
--
-- default_interval_months is how often the law (or nothing) says the check
-- recurs. The first time a recurring workflow is completed at a site, 0007
-- uses it to start that site's re-check clock. AV maintenance has none on
-- purpose: its cadence is the service contract's, set per site.

create table if not exists public.packs (
  id    text primary key,
  label text not null,
  sort  int  not null default 0
);

create table if not exists public.workflows (
  id                      text primary key,
  pack_id                 text not null references public.packs(id),
  label                   text not null,
  default_interval_months int check (default_interval_months is null
                                     or default_interval_months between 1 and 120)
);

insert into public.packs (id, label, sort) values
  ('core',       'Core',                              0),
  ('av',         'AV maintenance and commissioning',  1),
  ('vic_rental', 'Victorian rental safety checks',    2),
  ('qld_smoke',  'Queensland smoke alarm compliance', 3)
on conflict (id) do update set label = excluded.label, sort = excluded.sort;

-- VIC: electrical every 2 years and smoke alarms every 12 months, for every
-- rental from 13 October 2026. QLD: every alarm tested and cleaned at least once
-- every 12 months. Custom lists belong to 'core', which every team has.
insert into public.workflows (id, pack_id, label, default_interval_months) values
  ('custom',                'core',       'Custom list',                       null),
  ('maintenance',           'av',         'Preventative maintenance',          null),
  ('commissioning',         'av',         'Commissioning',                     null),
  ('vic_electrical_safety', 'vic_rental', 'Electrical safety check',           24),
  ('vic_smoke_alarm',       'vic_rental', 'Smoke alarm safety check',          12),
  ('qld_smoke_alarm',       'qld_smoke',  'Smoke alarm compliance inspection', 12)
on conflict (id) do update
  set pack_id                 = excluded.pack_id,
      label                   = excluded.label,
      default_interval_months = excluded.default_interval_months;

-- The CHECK lists from 0001 become foreign keys into the catalogue. Adding the
-- next state's rules is then one INSERT above, not another ALTER on two tables.
alter table public.visits         drop constraint if exists visits_kind_check;
alter table public.team_templates drop constraint if exists team_templates_kind_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'visits_kind_fkey') then
    alter table public.visits
      add constraint visits_kind_fkey foreign key (kind) references public.workflows(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_templates_kind_fkey') then
    alter table public.team_templates
      add constraint team_templates_kind_fkey foreign key (kind) references public.workflows(id);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- What kind of organisation a team is
-- ─────────────────────────────────────────────────────────────────────────────
--
--   provider — does the inspections: an AV integrator, an electrician.
--   landlord — owns rentals and receives reports about them.
--   agency   — manages rentals for many landlords and receives reports.
--
-- Every existing team is a provider, which is what they already are.

alter table public.teams add column if not exists account_type text not null default 'provider';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'teams_account_type_check') then
    alter table public.teams
      add constraint teams_account_type_check
      check (account_type in ('provider', 'landlord', 'agency'));
  end if;
end $$;

-- teams_update lets an admin PATCH the row, and RLS cannot say which columns.
-- So the privilege does: an admin renames and describes a team and touches
-- nothing else. Two locks, as with team_members in 0002. updateTeam() in
-- api.js only ever sends these two fields, so nothing in the app changes.
revoke update on table public.teams from anon, authenticated;
grant update (name, description) on table public.teams to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Plans, packs per team, and usage
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per team. Read by members, written only by the billing webhook.
--
--   seats               — only while Pro. NULL is unlimited. Free is always 1.
--   monthly_visit_limit — only while not Pro. NULL is unlimited (a promo).
--   comped              — not billed: the teams that existed before this file.
--
-- 'past_due' still counts as Pro. Stripe retries a failed card for days, and a
-- technician on a roof should not lose the app because a bank declined once.
create table if not exists public.subscriptions (
  team_id                uuid primary key references public.teams(id) on delete cascade,
  plan                   text not null default 'free' check (plan in ('free', 'pro')),
  status                 text not null default 'active'
                           check (status in ('active', 'trialing', 'past_due', 'canceled')),
  seats                  int check (seats is null or seats >= 1),
  monthly_visit_limit    int default 1 check (monthly_visit_limit is null or monthly_visit_limit >= 0),
  comped                 boolean not null default false,
  stripe_customer_id     text,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

-- Which packs a team has. 'core' is implicit and never stored.
--
--   starter — the one pack a team picks for itself, free or paid.
--   addon   — bought on top, written by the billing webhook.
--   comped  — granted by hand.
create table if not exists public.team_packs (
  team_id    uuid not null references public.teams(id) on delete cascade,
  pack_id    text not null references public.packs(id),
  source     text not null default 'starter' check (source in ('starter', 'addon', 'comped')),
  enabled_at timestamptz not null default now(),
  primary key (team_id, pack_id)
);

-- One starter per team, made true by the database rather than by every caller.
create unique index if not exists team_packs_one_starter_idx
  on public.team_packs(team_id) where source = 'starter';

-- Inspections started per calendar month. A counter rather than a count of
-- visits, so deleting this month's visits does not hand the allowance back.
create table if not exists public.team_usage (
  team_id        uuid not null references public.teams(id) on delete cascade,
  period         date not null,   -- first day of the month, Sydney time
  visits_started int  not null default 0,
  primary key (team_id, period)
);

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- The switch. One row, readable by everybody signed in so the UI can tell
-- "you would need Pro for this" from "you need Pro for this".
create table if not exists public.app_settings (
  id             boolean primary key default true check (id),
  enforce_limits boolean not null default false,
  updated_at     timestamptz not null default now()
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at before update on public.app_settings
  for each row execute function public.set_updated_at();

create or replace function public.limits_enforced()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select s.enforce_limits from public.app_settings s where s.id), false);
$$;

-- The calendar day a moment falls on, in Sydney. Months and due dates are
-- reckoned in it so that a job finished at 10pm lands on the right day. One
-- function, so going national is a one-line change rather than a hunt.
create or replace function public.local_day(_at timestamptz)
returns date language sql stable set search_path = public as $$
  select (_at at time zone 'Australia/Sydney')::date;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grandfathering. Runs BEFORE the provisioning trigger exists, and only for
-- teams with no plan at all — so on a re-run it finds nothing to do, and a
-- re-run can never quietly turn this month's free sign-ups into comped Pro.
-- ─────────────────────────────────────────────────────────────────────────────

with legacy as (
  insert into public.subscriptions (team_id, plan, status, seats, monthly_visit_limit, comped)
  select t.id, 'pro', 'active', null, null, true
    from public.teams t
   where not exists (select 1 from public.subscriptions s where s.team_id = t.id)
  returning team_id
)
insert into public.team_packs (team_id, pack_id, source)
select team_id, 'av', 'comped' from legacy
on conflict (team_id, pack_id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Every new team: a Free plan, and AV as its starter pack
-- ─────────────────────────────────────────────────────────────────────────────
--
-- AV, because the create_team() the app calls today knows nothing about packs,
-- and the only workflows on screen are AV ones. create_organisation() below is
-- the new door, and it swaps the starter for whatever was actually chosen.

create or replace function public.provision_team()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions (team_id) values (new.id)
    on conflict (team_id) do nothing;
  insert into public.team_packs (team_id, pack_id, source) values (new.id, 'av', 'starter')
    on conflict (team_id, pack_id) do nothing;
  return new;
end;
$$;

drop trigger if exists teams_provision on public.teams;
create trigger teams_provision after insert on public.teams
  for each row execute function public.provision_team();

-- ─────────────────────────────────────────────────────────────────────────────
-- What a team is entitled to. SECURITY DEFINER because the gates below run as
-- whoever is writing, and must see the plan regardless of what that person can
-- read. A team with no plan row is treated as Free: fail closed, not open.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.team_is_pro(_team_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select s.plan = 'pro' and s.status in ('active', 'trialing', 'past_due')
      from public.subscriptions s
     where s.team_id = _team_id
  ), false);
$$;

-- NULL means unlimited.
create or replace function public.team_seat_limit(_team_id uuid)
returns int language sql security definer stable set search_path = public as $$
  select case
    when public.team_is_pro(_team_id)
      then (select s.seats from public.subscriptions s where s.team_id = _team_id)
    else 1
  end;
$$;

-- NULL means unlimited.
create or replace function public.team_visit_limit(_team_id uuid)
returns int language sql security definer stable set search_path = public as $$
  select case
    when public.team_is_pro(_team_id) then null
    when not exists (select 1 from public.subscriptions s where s.team_id = _team_id) then 1
    else (select s.monthly_visit_limit from public.subscriptions s where s.team_id = _team_id)
  end;
$$;

create or replace function public.team_has_pack(_team_id uuid, _pack_id text)
returns boolean language sql security definer stable set search_path = public as $$
  select _pack_id = 'core'
      or exists (
        select 1 from public.team_packs p
         where p.team_id = _team_id and p.pack_id = _pack_id
      );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Gate 1: starting an inspection needs the pack, and an allowance left
-- ─────────────────────────────────────────────────────────────────────────────
--
-- BEFORE INSERT, so a refusal costs nothing: the counter bump and the row roll
-- back together. That also covers the duplicate-open-visit race startVisit()
-- already handles — the loser's 23505 undoes its increment too.

create or replace function public.gate_visit_start()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_pack   text;
  v_label  text;
  v_limit  int;
  v_used   int;
  v_period date := date_trunc('month', public.local_day(now()))::date;
begin
  select w.pack_id, p.label into v_pack, v_label
    from public.workflows w
    join public.packs p on p.id = w.pack_id
   where w.id = new.kind;

  if v_pack is null then
    raise exception 'There is no workflow called "%"', new.kind;
  end if;

  if public.limits_enforced() and not public.team_has_pack(new.team_id, v_pack) then
    raise exception 'This team does not have the % pack', v_label
      using errcode = 'PT402', hint = 'upgrade';
  end if;

  -- Counted by when the work started, not when the row arrived: importing last
  -- year's visits from a browser's local data is history, not this month's use.
  -- Counted with the switch off too, so there is real usage to price against.
  if public.local_day(new.started_at) >= v_period then
    insert into public.team_usage as u (team_id, period, visits_started)
      values (new.team_id, v_period, 1)
      on conflict (team_id, period) do update set visits_started = u.visits_started + 1
      returning u.visits_started into v_used;

    v_limit := public.team_visit_limit(new.team_id);
    if public.limits_enforced() and v_limit is not null and v_used > v_limit then
      raise exception 'This plan includes % inspection% a month, and this month''s % been used',
        v_limit,
        case when v_limit = 1 then '' else 's' end,
        case when v_limit = 1 then 'has' else 'have' end
        using errcode = 'PT402', hint = 'upgrade';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists visits_gate_start on public.visits;
create trigger visits_gate_start before insert on public.visits
  for each row execute function public.gate_visit_start();

-- ─────────────────────────────────────────────────────────────────────────────
-- Gate 2: seats
-- ─────────────────────────────────────────────────────────────────────────────
--
-- On team_members itself, so it holds on every road in: join_team,
-- accept_invite, the confirmation trigger, and move_member (an UPDATE of
-- team_id, hence the second event). The plan row is locked first so two people
-- accepting the last seat at the same moment cannot both get it.
--
-- consume_invite_on_confirm (0005) swallows errors by design, so a person
-- confirming into a full team simply isn't added. Gate 3 is what stops it
-- getting that far.

create or replace function public.gate_team_seats()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_limit int;
  v_used  int;
begin
  -- Nested, not `tg_op = 'UPDATE' and old.team_id ...` — see 0005 for why
  -- touching OLD on an INSERT is an error rather than a false.
  if tg_op = 'UPDATE' then
    if new.team_id = old.team_id then return new; end if;
  end if;
  if not public.limits_enforced() then return new; end if;

  perform 1 from public.subscriptions where team_id = new.team_id for update;

  v_limit := public.team_seat_limit(new.team_id);
  if v_limit is null then return new; end if;

  select count(*) into v_used from public.team_members where team_id = new.team_id;
  if v_used >= v_limit then
    raise exception 'This team''s plan has % seat%, and every one is taken',
      v_limit, case when v_limit = 1 then '' else 's' end
      using errcode = 'PT402', hint = 'upgrade';
  end if;

  return new;
end;
$$;

drop trigger if exists team_members_gate_seats on public.team_members;
create trigger team_members_gate_seats before insert or update of team_id on public.team_members
  for each row execute function public.gate_team_seats();

-- ─────────────────────────────────────────────────────────────────────────────
-- Gate 3: invitations count against seats too
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Otherwise an admin invites five people to a three-seat team, two of them
-- confirm into nothing, and nobody is told why. Refusing at invite time puts
-- the message in front of the one person who can do something about it.
-- create_invite (0005) clears a re-invited address's old row before inserting,
-- so re-sending an expired invite does not count twice.

create or replace function public.gate_team_invites()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_limit int;
  v_used  int;
begin
  if not public.limits_enforced() then return new; end if;
  v_limit := public.team_seat_limit(new.team_id);
  if v_limit is null then return new; end if;

  select (select count(*) from public.team_members m where m.team_id = new.team_id)
       + (select count(*) from public.team_invites i
           where i.team_id = new.team_id and i.accepted_at is null and i.expires_at > now())
    into v_used;

  if v_used >= v_limit then
    raise exception 'Every seat on this team''s plan is taken or already invited (% of %)', v_used, v_limit
      using errcode = 'PT402', hint = 'upgrade';
  end if;

  return new;
end;
$$;

drop trigger if exists team_invites_gate_seats on public.team_invites;
create trigger team_invites_gate_seats before insert on public.team_invites
  for each row execute function public.gate_team_invites();

-- ─────────────────────────────────────────────────────────────────────────────
-- Onboarding RPCs
-- ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the team's one starter pack. Owner or admin, providers only.
 *
 * Swapping is allowed until the team has done any work under the old pack.
 * After that the old pack stays and the other one is an add-on — otherwise a
 * free team could rotate through every pack, a month at a time.
 */
create or replace function public.choose_starter_pack(p_team_id uuid, p_pack_id text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.is_team_admin(p_team_id) then
    raise exception 'Only an owner or admin can choose this team''s pack';
  end if;
  if p_pack_id = 'core' or not exists (select 1 from public.packs where id = p_pack_id) then
    raise exception 'There is no pack called "%"', p_pack_id;
  end if;
  if (select account_type from public.teams where id = p_team_id) <> 'provider' then
    raise exception 'Packs are for teams that carry out inspections';
  end if;

  select pack_id into v_old
    from public.team_packs
   where team_id = p_team_id and source = 'starter';

  if v_old = p_pack_id then return; end if;

  if v_old is not null then
    if exists (
      select 1 from public.visits v
      join public.workflows w on w.id = v.kind
      where v.team_id = p_team_id and w.pack_id = v_old
    ) then
      raise exception 'This team already has work under its current pack, so it cannot be swapped. Add the other pack instead.'
        using errcode = 'PT402', hint = 'upgrade';
    end if;
    delete from public.team_packs
     where team_id = p_team_id and pack_id = v_old and source = 'starter';
  end if;

  insert into public.team_packs (team_id, pack_id, source)
    values (p_team_id, p_pack_id, 'starter')
    on conflict (team_id, pack_id) do nothing;

  -- Empty rows, exactly as create_team leaves its three: the app seeds each one
  -- from src/data/ on first read, and only an admin's write persists it.
  insert into public.team_templates (team_id, kind)
    select p_team_id, w.id from public.workflows w where w.pack_id = p_pack_id
    on conflict (team_id, kind) do nothing;
end;
$$;

/**
 * The new way in: create a team that knows what it is.
 *
 * Wraps create_team() rather than replacing it, so the Team Setup screen that
 * calls create_team today keeps working untouched until the new onboarding
 * ships. Landlord and agency teams get no pack: they receive reports, they do
 * not carry out inspections.
 */
create or replace function public.create_organisation(
  p_name         text,
  p_account_type text default 'provider',
  p_pack_id      text default null,
  p_description  text default ''
)
returns public.teams language plpgsql security definer set search_path = public as $$
declare v_team public.teams;
begin
  if coalesce(p_account_type, '') not in ('provider', 'landlord', 'agency') then
    raise exception 'An organisation is a provider, a landlord or an agency, not "%"', p_account_type;
  end if;

  v_team := public.create_team(p_name, p_description);

  update public.teams set account_type = p_account_type
   where id = v_team.id
   returning * into v_team;

  -- provision_team() gave it AV. Clear that and set what was actually chosen.
  delete from public.team_packs where team_id = v_team.id and source = 'starter';
  if p_account_type = 'provider' then
    perform public.choose_starter_pack(v_team.id, coalesce(p_pack_id, 'av'));
  end if;

  return v_team;
end;
$$;

/**
 * Everything the UI needs to explain a limit before somebody hits it.
 * Members only; NULL limits are unlimited.
 */
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
                    ), '[]'::jsonb)
  ) end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security and privileges
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.packs         enable row level security;
alter table public.workflows     enable row level security;
alter table public.subscriptions enable row level security;
alter table public.team_packs    enable row level security;
alter table public.team_usage    enable row level security;
alter table public.app_settings  enable row level security;

drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings
  for select to authenticated using (true);

drop policy if exists packs_select on public.packs;
create policy packs_select on public.packs
  for select to authenticated using (true);

drop policy if exists workflows_select on public.workflows;
create policy workflows_select on public.workflows
  for select to authenticated using (true);

-- A team's own plan, packs and usage: readable by its members, writable by no
-- client at all. There is deliberately no INSERT, UPDATE or DELETE policy.
drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions
  for select to authenticated using (public.is_team_member(team_id));

drop policy if exists team_packs_select on public.team_packs;
create policy team_packs_select on public.team_packs
  for select to authenticated using (public.is_team_member(team_id));

drop policy if exists team_usage_select on public.team_usage;
create policy team_usage_select on public.team_usage
  for select to authenticated using (public.is_team_member(team_id));

-- And the privileges agree, so it is two locks rather than one.
revoke all on table
  public.packs, public.workflows, public.subscriptions, public.team_packs, public.team_usage,
  public.app_settings
from anon, authenticated;

grant select on table
  public.packs, public.workflows, public.subscriptions, public.team_packs, public.team_usage,
  public.app_settings
to authenticated;

-- Trigger functions: nobody calls these directly.
revoke execute on function public.provision_team()    from public, anon, authenticated;
revoke execute on function public.gate_visit_start()  from public, anon, authenticated;
revoke execute on function public.gate_team_seats()   from public, anon, authenticated;
revoke execute on function public.gate_team_invites() from public, anon, authenticated;

-- Helpers. Policies in 0007 call these as the signed-in user, so they stay
-- executable for `authenticated`; `anon` has no use for them.
revoke execute on function public.local_day(timestamptz)        from public, anon;
revoke execute on function public.limits_enforced()             from public, anon;
grant  execute on function public.limits_enforced()             to authenticated;
revoke execute on function public.team_is_pro(uuid)             from public, anon;
revoke execute on function public.team_seat_limit(uuid)         from public, anon;
revoke execute on function public.team_visit_limit(uuid)        from public, anon;
revoke execute on function public.team_has_pack(uuid, text)     from public, anon;
grant  execute on function public.local_day(timestamptz)        to authenticated;
grant  execute on function public.team_is_pro(uuid)             to authenticated;
grant  execute on function public.team_seat_limit(uuid)         to authenticated;
grant  execute on function public.team_visit_limit(uuid)        to authenticated;
grant  execute on function public.team_has_pack(uuid, text)     to authenticated;

revoke execute on function public.choose_starter_pack(uuid, text)               from public, anon;
revoke execute on function public.create_organisation(text, text, text, text)   from public, anon;
revoke execute on function public.team_entitlements(uuid)                       from public, anon;
grant  execute on function public.choose_starter_pack(uuid, text)               to authenticated;
grant  execute on function public.create_organisation(text, text, text, text)   to authenticated;
grant  execute on function public.team_entitlements(uuid)                       to authenticated;

-- PostgREST caches the schema; without this the new functions 404 until the
-- next restart.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification. Expected: packs 4, workflows 6, teams_without_plan 0,
-- kind_fkeys 2, gates 4, and enforced false until you turn it on. The second
-- result lists every team with its plan — the ones that existed before this
-- file should read pro / comped / av.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select enforce_limits from public.app_settings)                          as enforced,
  (select count(*) from public.packs)                                        as packs,
  (select count(*) from public.workflows)                                    as workflows,
  (select count(*) from public.teams t
    where not exists (select 1 from public.subscriptions s where s.team_id = t.id))
                                                                             as teams_without_plan,
  (select count(*) from pg_constraint
    where conname in ('visits_kind_fkey', 'team_templates_kind_fkey'))       as kind_fkeys,
  (select count(*) from pg_trigger
    where not tgisinternal and tgname in ('teams_provision', 'visits_gate_start',
                                          'team_members_gate_seats', 'team_invites_gate_seats'))
                                                                             as gates;

select t.name, t.account_type, s.plan, s.comped,
       coalesce(string_agg(p.pack_id || ' (' || p.source || ')', ', ' order by p.pack_id), '') as packs
  from public.teams t
  join public.subscriptions s on s.team_id = t.id
  left join public.team_packs p on p.team_id = t.id
 group by t.name, t.account_type, s.plan, s.comped
 order by t.name;
