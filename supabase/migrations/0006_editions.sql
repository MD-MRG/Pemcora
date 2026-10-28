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
-- AV maintenance, Victorian rental safety checks, Queensland electrical and
-- smoke alarm compliance, and an electrical baseline for every other state,
-- with room for more. Each edition is a PACK of WORKFLOWS. A workflow is what
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
-- One check is not behind the switch, because it is about honest records
-- rather than money: a visit's start and completion dates must be within the
-- last 7 days (Gate 1). Older work comes in once, through the owner's import
-- window, which src/lib/migrate.js opens before importing.
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
--
-- interval_fixed marks an interval the law sets. A team can choose its own
-- cadence for any other workflow, but not for these.

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
                                     or default_interval_months between 1 and 120),
  interval_fixed          boolean not null default false
);

insert into public.packs (id, label, sort) values
  ('core',               'Core',                                             0),
  ('av',                 'AV maintenance and commissioning',                 1),
  ('vic_rental',         'Victorian rental safety checks',                   2),
  ('qld_electrical',     'Queensland electrical and smoke alarm compliance', 3),
  ('electrical_general', 'Electrical compliance baseline',                   4)
on conflict (id) do update set label = excluded.label, sort = excluded.sort;

-- VIC: electrical every 2 years and smoke alarms every 12 months, for every
-- rental from 13 October 2026, both fixed by law. QLD: every alarm tested and
-- cleaned at least once every 12 months, fixed; the electrical check defaults
-- to 2 years and the team may change it. electrical_general is the baseline
-- for states without their own pack yet, so nothing in it is fixed. Custom
-- lists belong to 'core', which every team has.
insert into public.workflows (id, pack_id, label, default_interval_months, interval_fixed) values
  ('custom',                'core',               'Custom list',                       null, false),
  ('maintenance',           'av',                 'Preventative maintenance',          null, false),
  ('commissioning',         'av',                 'Commissioning',                     null, false),
  ('vic_electrical_safety', 'vic_rental',         'Electrical safety check',           24,   true),
  ('vic_smoke_alarm',       'vic_rental',         'Smoke alarm safety check',          12,   true),
  ('qld_smoke_alarm',       'qld_electrical',     'Smoke alarm compliance inspection', 12,   true),
  ('qld_electrical_safety', 'qld_electrical',     'Electrical safety check',           24,   false),
  ('electrical_safety',     'electrical_general', 'Electrical safety check',           24,   false),
  ('smoke_alarm_check',     'electrical_general', 'Smoke alarm check',                 12,   false)
on conflict (id) do update
  set pack_id                 = excluded.pack_id,
      label                   = excluded.label,
      default_interval_months = excluded.default_interval_months,
      interval_fixed          = excluded.interval_fixed;

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

-- The one-time window for importing older work (see Gate 1). Written only by
-- open_import_window(); the column grant below keeps the app off both.
alter table public.teams add column if not exists import_open_until timestamptz;
alter table public.teams add column if not exists import_used_at    timestamptz;

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
--   past_due_since      — the first failed payment of the current run of them.
--   cancel_at           — when a cancelled plan stops: the end of the paid period.
--
-- 'past_due' counts as Pro for 7 days from past_due_since. Stripe retries a
-- failed card for days, and a technician on a roof should not lose the app
-- because a bank declined once — but nor does a card that never pays keep Pro
-- for as long as Stripe keeps trying. cancel_at ends Pro on the day itself,
-- whether or not the webhook that says so has arrived.
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
  past_due_since         timestamptz,
  cancel_at              timestamptz,
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

-- The grace clock is the database's, not the webhook's to remember. It starts
-- the first time a plan goes past due and stops when the status moves on — a
-- successful payment ends it. While the plan stays past due it only ever moves
-- earlier: Stripe re-sending past_due on every retry, or a webhook that writes
-- every column and sends past_due_since empty or later, cannot restart it or
-- stretch the 7 days. The webhook may set an earlier date, from the failed
-- invoice.
create or replace function public.track_past_due()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status <> 'past_due' then
    new.past_due_since := null;
    return new;
  end if;

  -- Nested, not `tg_op = 'UPDATE' and old.status ...` — see 0005.
  if tg_op = 'UPDATE' then
    if old.status = 'past_due' and old.past_due_since is not null then
      new.past_due_since := least(old.past_due_since, coalesce(new.past_due_since, old.past_due_since));
    end if;
  end if;
  if new.past_due_since is null then
    new.past_due_since := now();
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_track_past_due on public.subscriptions;
create trigger subscriptions_track_past_due before insert or update on public.subscriptions
  for each row execute function public.track_past_due();

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
    select s.plan = 'pro'
       and (s.status in ('active', 'trialing')
            or (s.status = 'past_due'
                and s.past_due_since is not null
                and now() < s.past_due_since + interval '7 days'))
       and (s.cancel_at is null or now() < s.cancel_at)
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
-- Gate 1: starting an inspection needs the pack, honest dates, and an
-- allowance left
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Five triggers, because the order of the checks is the rule:
--
--   visits_gate_pack      BEFORE INSERT: the pack, and the dates.
--   visits_gate_dates     BEFORE UPDATE OF started_at, completed_at,
--                         first_completed_at: what may change about the dates.
--   visits_gate_identity  BEFORE UPDATE OF kind, location_id, team_id: nothing.
--   visits_count_start    AFTER INSERT: the monthly counter, and the allowance.
--   visits_count_import   AFTER UPDATE OF completed_at: an imported visit that
--                         was still open counts when it is finished later.
--
-- The counter runs AFTER the row is in, so the one-open-visit index
-- (visits_one_open_per_kind_idx, 0001) answers first. A second device starting
-- the visit that is already open gets 23505, which startVisit() in api.js turns
-- into "join the open visit" — nothing counted, nothing refused, even with the
-- allowance used up. Only a different visit reaches the counter and its 402.
-- A refusal still costs nothing: the row and the counter bump roll back
-- together.
--
-- Dates. Visits are counted in the month the server says it is, never the one
-- the device sends, so a start date in last month no longer dodges the count.
-- And the dates themselves must be recent: no more than 7 days back (a device
-- that was offline for a few days) and no more than an hour ahead (a fast
-- clock). Otherwise a team could put any completion date it liked on a
-- compliance report. Each date is checked whenever it is written — on insert,
-- and on any UPDATE that changes it — never the other one alongside it: a
-- visit started a fortnight ago can be finished today, but neither date can
-- later be moved into the past through the API. A visit never ends before it
-- began.
--
-- Reopening a finished visit is for corrections, so completing it again keeps
-- the date it was first completed (first_completed_at): the report, the due
-- date and the month's count all stay as they were. A new inspection of the
-- same site is a new visit, and that one counts. Without this, last year's
-- visit could be reopened and done again, uncounted, as this year's check.
--
-- The one exception is the import window: a team's owner may open it once,
-- for 15 minutes, to bring in work from before the account existed. A visit
-- started more than 7 days ago that comes in while it is open may carry any
-- past date (never a future one), and one started before this month and
-- finished more than 7 days ago is history, not this month's use. Finished in
-- the last 7 days, it is this month's work and counts, whatever start it
-- claims. See open_import_window() below.

-- When a visit was first completed: the triggers below keep it, and never take
-- it from the client. Visits completed before this file get it from their
-- completed_at; a re-run finds none left to fill.
alter table public.visits add column if not exists first_completed_at timestamptz;
update public.visits set first_completed_at = completed_at
 where first_completed_at is null and completed_at is not null;

-- When the server first saw the visit completed. The 7 days in which a
-- completion date may still be corrected run from here, or from the date
-- itself if that is earlier, so correcting it every few days cannot keep the
-- window open. Kept from the client like first_completed_at; a visit completed
-- before this file counts from its completion date.
alter table public.visits add column if not exists completion_recorded_at timestamptz;
update public.visits set completion_recorded_at = completed_at
 where completion_recorded_at is null and completed_at is not null;

-- True while the team's one-time import window is open.
create or replace function public.import_window_open(_team_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select t.import_open_until > now() from public.teams t where t.id = _team_id
  ), false);
$$;

-- Refuses a visit date outside [now - 7 days, now + 1 hour].
create or replace function public.check_visit_date(_what text, _at timestamptz)
returns void language plpgsql stable set search_path = public as $$
begin
  if _at < now() - interval '7 days' then
    raise exception '% is more than 7 days ago. Older work can only come in through the one-time import.', _what
      using errcode = 'check_violation', hint = 'visit_date';
  end if;
  if _at > now() + interval '1 hour' then
    raise exception '% is in the future. Check the date and time on this device.', _what
      using errcode = 'check_violation', hint = 'visit_date';
  end if;
end;
$$;

-- Refuses a date in the future: the one date check the import window keeps.
create or replace function public.check_visit_not_future(_what text, _at timestamptz)
returns void language plpgsql stable set search_path = public as $$
begin
  if _at > now() + interval '1 hour' then
    raise exception '% is in the future. Check the date and time on this device.', _what
      using errcode = 'check_violation', hint = 'visit_date';
  end if;
end;
$$;

-- Refuses a completion before the start, with an hour's leeway for two
-- devices' clocks. Imports included: old work cannot end before it began either.
create or replace function public.check_visit_order(_started_at timestamptz, _completed_at timestamptz)
returns void language plpgsql immutable set search_path = public as $$
begin
  if _completed_at is not null and _completed_at < _started_at - interval '1 hour' then
    raise exception 'The visit''s completion date is before its start date'
      using errcode = 'check_violation', hint = 'visit_date';
  end if;
end;
$$;

-- The visits that came in through the import window: started more than 7
-- days ago and inserted while it was open. Only the triggers below write or
-- read it. pending is true for one that started before the month it came in
-- and was still open: history while the window is open, but this month's
-- inspection if it is finished after the window has closed.
create table if not exists public.visit_imports (
  visit_id uuid primary key references public.visits(id) on delete cascade,
  pending  boolean not null
);
alter table public.visit_imports enable row level security;
revoke all on table public.visit_imports from anon, authenticated;

-- One more inspection this month, refused past the plan's allowance.
create or replace function public.count_inspection(_team_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_limit  int;
  v_used   int;
  v_period date := date_trunc('month', public.local_day(now()))::date;
begin
  -- Counted with the switch off too, so there is real usage to price against.
  insert into public.team_usage as u (team_id, period, visits_started)
    values (_team_id, v_period, 1)
    on conflict (team_id, period) do update set visits_started = u.visits_started + 1
    returning u.visits_started into v_used;

  v_limit := public.team_visit_limit(_team_id);
  if public.limits_enforced() and v_limit is not null and v_used > v_limit then
    raise exception 'This plan includes % inspection% a month, and this month''s % been used',
      v_limit,
      case when v_limit = 1 then '' else 's' end,
      case when v_limit = 1 then 'has' else 'have' end
      using errcode = 'PT402', hint = 'upgrade';
  end if;
end;
$$;

create or replace function public.gate_visit_pack()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_pack  text;
  v_label text;
begin
  select w.pack_id, p.label into v_pack, v_label
    from public.workflows w
    join public.packs p on p.id = w.pack_id
   where w.id = new.kind;

  if v_pack is null then
    raise exception 'There is no workflow called "%"', new.kind;
  end if;

  -- Read under a share lock on the pack row this visit relies on.
  -- choose_starter_pack() locks the same row before it looks for visits, and
  -- the webhook's delete of an add-on waits for it too, so neither can pass a
  -- visit that is being saved under the pack it is taking away.
  if v_pack <> 'core' then
    perform 1 from public.team_packs p
     where p.team_id = new.team_id and p.pack_id = v_pack
       for share;
    if not found and public.limits_enforced() then
      raise exception 'This team does not have the % pack', v_label
        using errcode = 'PT402', hint = 'upgrade';
    end if;
  end if;

  -- Not behind the switch: an honest date matters on a compliance report
  -- whether or not anybody is paying. Old work coming in through the import
  -- window may carry any past date, never a future one. A visit started in the
  -- last 7 days is today's work, window or not, and is held to the last 7 days.
  if public.import_window_open(new.team_id) and new.started_at < now() - interval '7 days' then
    if new.completed_at is not null then
      perform public.check_visit_not_future('The visit''s completion date', new.completed_at);
    end if;
  else
    perform public.check_visit_date('The visit''s start date', new.started_at);
    if new.completed_at is not null then
      perform public.check_visit_date('The visit''s completion date', new.completed_at);
    end if;
  end if;
  perform public.check_visit_order(new.started_at, new.completed_at);

  -- The database's record of when the visit was first completed, never the
  -- client's.
  new.first_completed_at := new.completed_at;
  new.completion_recorded_at := case when new.completed_at is not null then now() end;
  return new;
end;
$$;

-- What may change about a visit's dates once it exists:
--
--   started_at          checked like any new date, whenever it changes.
--   completed_at        set for the first time: checked like any new date (an
--                       imported visit, inside the window, may take an old
--                       one). Changed while set: only within 7 days of when it
--                       was recorded, and only to a date in the last 7 days.
--                       Cleared: that is reopenVisit(), and allowed.
--   completing a reopened visit: it keeps the date it was first completed,
--                       whatever date the app sends (see the section header).
--   first_completed_at  the database's, never the client's: kept as it was.
--
-- Sending the same values back is not a change, and passes: the app re-sends
-- completed_at with every other change to a visit, finished months ago or not.
create or replace function public.gate_visit_dates()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  -- Only the import's own visits, and only while its window is open, may be
  -- completed with an old date: the app inserts each one open and then
  -- completes it.
  v_import boolean := public.import_window_open(new.team_id)
                      and exists (select 1 from public.visit_imports i where i.visit_id = new.id);
begin
  -- The database's to keep. A completed visit with none on record (written
  -- with the triggers off, say) takes its own completion date, so any write
  -- heals it and the backfill above works on a re-run too.
  new.first_completed_at := coalesce(old.first_completed_at, old.completed_at);
  new.completion_recorded_at := coalesce(old.completion_recorded_at, old.completed_at);

  if new.started_at is distinct from old.started_at then
    perform public.check_visit_date('The visit''s start date', new.started_at);
    -- A reopened visit gets its first completion date back, so its start
    -- cannot move past that date either, nor when this same write completes it
    -- again: that date, not the one the app sent, is the one it will end with.
    perform public.check_visit_order(new.started_at,
      case when new.completed_at is not null and old.completed_at is null and old.first_completed_at is not null
           then old.first_completed_at
           else coalesce(new.completed_at, new.first_completed_at) end);
  end if;

  if new.completed_at is not null and old.completed_at is null and old.first_completed_at is not null then
    -- The date it was first completed, checked when it was first set. Not
    -- checked against the start again: the start check above already holds it
    -- if the start moved, and a visit from before this file whose dates were
    -- out of order all along must still be able to close once reopened.
    new.completed_at := old.first_completed_at;
    return new;
  end if;

  if new.completed_at is not null and new.completed_at is distinct from old.completed_at then
    if old.completed_at is not null
       and least(old.completion_recorded_at, old.completed_at) < now() - interval '7 days' then
      raise exception 'This visit was completed more than 7 days ago, so its completion date can no longer be changed'
        using errcode = 'check_violation', hint = 'visit_date';
    end if;
    if v_import and old.completed_at is null then
      perform public.check_visit_not_future('The visit''s completion date', new.completed_at);
    else
      perform public.check_visit_date('The visit''s completion date', new.completed_at);
    end if;
    new.first_completed_at := new.completed_at;
    -- The first completion is when the server saw it; a correction keeps that.
    if old.completed_at is null then
      new.completion_recorded_at := now();
    end if;
  end if;

  -- Only when a date moved: a row from before this file whose dates are out of
  -- order still takes every other edit.
  if new.started_at is distinct from old.started_at or new.completed_at is distinct from old.completed_at then
    perform public.check_visit_order(new.started_at, new.completed_at);
  end if;
  return new;
end;
$$;

create or replace function public.count_visit_start()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_period date := date_trunc('month', public.local_day(now()))::date;
begin
  -- Old work brought in through the import window — started more than 7 days
  -- ago — is remembered as the import's. Started before this month and
  -- finished more than 7 days ago, it is history, not this month's use; still
  -- open, it stays pending until it is finished. Anything finished in the last
  -- 7 days is this month's work, whenever it says it started, and counts.
  if public.import_window_open(new.team_id) and new.started_at < now() - interval '7 days' then
    insert into public.visit_imports (visit_id, pending)
      values (new.id, public.local_day(new.started_at) < v_period and new.completed_at is null)
      on conflict (visit_id) do nothing;
    if public.local_day(new.started_at) < v_period
       and (new.completed_at is null or new.completed_at < now() - interval '7 days') then
      return new;
    end if;
  end if;

  perform public.count_inspection(new.team_id);
  return new;
end;
$$;

drop trigger if exists visits_gate_pack on public.visits;
create trigger visits_gate_pack before insert on public.visits
  for each row execute function public.gate_visit_pack();

drop trigger if exists visits_gate_dates on public.visits;
create trigger visits_gate_dates
  before update of started_at, completed_at, first_completed_at, completion_recorded_at on public.visits
  for each row execute function public.gate_visit_dates();

drop trigger if exists visits_count_start on public.visits;
create trigger visits_count_start after insert on public.visits
  for each row execute function public.count_visit_start();

-- An old visit the import brought in still open is history only if it is
-- finished with an old date while the window is open: that is how migrate.js
-- brings in past work. Finished after the window has closed, or with a date in
-- the last 7 days, it is this month's inspection, counted (and refused past the
-- allowance) like any other start.
create or replace function public.count_imported_visit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.completed_at is null or old.completed_at is not null then return new; end if;
  update public.visit_imports set pending = false where visit_id = new.id and pending;
  if found and (not public.import_window_open(new.team_id)
                or new.completed_at >= now() - interval '7 days') then
    perform public.count_inspection(new.team_id);
  end if;
  return new;
end;
$$;

drop trigger if exists visits_count_import on public.visits;
create trigger visits_count_import after update of completed_at on public.visits
  for each row execute function public.count_imported_visit();

-- A visit's check, site and team are what the insert gates above checked, so
-- they never change afterwards. Otherwise one counted visit could be pointed
-- at site after site, or an AV visit turned into a VIC check without the pack.
-- Sending the same values back (an upsert, say) is not a change and passes.
create or replace function public.gate_visit_identity()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.kind is distinct from old.kind
     or new.location_id is distinct from old.location_id
     or new.team_id is distinct from old.team_id then
    raise exception 'A visit''s check, site and team are fixed once it has started. Start a new visit instead.'
      using errcode = 'check_violation', hint = 'visit_identity';
  end if;
  return new;
end;
$$;

drop trigger if exists visits_gate_identity on public.visits;
create trigger visits_gate_identity before update of kind, location_id, team_id on public.visits
  for each row execute function public.gate_visit_identity();

-- ─────────────────────────────────────────────────────────────────────────────
-- Gate 2: seats
-- ─────────────────────────────────────────────────────────────────────────────
--
-- On team_members itself, so it holds on every road in: join_team,
-- accept_invite, the confirmation trigger, and move_member (an UPDATE of
-- team_id, hence the second event). The plan row is locked first so two people
-- accepting the last seat at the same moment cannot both get it.
--
-- The last line of defence. join_team, accept_invite and the confirmation
-- trigger ask claim_seat() first (see "Seat races" below), which can cancel
-- the losing invitation and tell the admins — a raise from here would undo
-- both.

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
  -- The lock gate_team_seats and claim_seat take, so two invitations for the
  -- last seat queue here and the second one counts the first.
  perform 1 from public.subscriptions where team_id = new.team_id for update;
  v_limit := public.team_seat_limit(new.team_id);
  if v_limit is null then return new; end if;

  select (select count(*) from public.team_members m where m.team_id = new.team_id)
       + (select count(*) from public.team_invites i
           where i.team_id = new.team_id and i.accepted_at is null
             and i.cancelled_at is null and i.expires_at > now())
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
-- Seat races: two people, one seat
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Gate 3 stops an admin inviting more people than there are seats, but seats
-- can still run out under an invitation already sent: the seat count is
-- lowered, or somebody joins with the team code while the invitation is open.
-- Then whoever arrives second misses out. Their invitation is cancelled, and
-- the team's owners and admins get a notice naming them, so the person who
-- sent it learns why it never came to anything.
--
-- That only works if nothing raises: an exception would roll back the
-- cancellation and the notice along with the membership. So join_team and
-- accept_invite return {status: 'full'} instead of an error, and the
-- confirmation trigger never raises at all (0005's rule). Their success result
-- keeps the team's id and name, which is all the app reads from it today.

alter table public.team_invites add column if not exists invitee_name  text not null default '';
alter table public.team_invites add column if not exists cancelled_at  timestamptz;
alter table public.team_invites add column if not exists cancel_reason text;

-- 0005 granted select and delete but relied on RLS alone against writes, and
-- Supabase's default privileges grant everything to anon too. Two locks:
-- invitations are minted, spent and cancelled only by functions.
revoke all on table public.team_invites from anon;
revoke insert, update on table public.team_invites from authenticated;

-- Things a team's owners and admins need to be told. Written only by functions
-- and the billing webhook; the app reads them and marks them read.
create table if not exists public.team_notices (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams(id) on delete cascade,
  kind       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists team_notices_team_idx on public.team_notices(team_id, created_at desc);

/**
 * The one seat check every road in shares. True if the caller may add a member.
 *
 * Locks the plan row — the same lock gate_team_seats takes — so two people going
 * for the last seat queue here, and the second counts the first. When the team
 * is full and the attempt came through an invitation, that invitation is
 * cancelled and the admins get an 'invite_cancelled_no_seats' notice.
 *
 * Internal: never callable by a client, or anyone could cancel anyone's
 * invitations.
 */
create or replace function public.claim_seat(_team_id uuid, _invite_id uuid default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_limit  int;
  v_used   int;
  v_invite public.team_invites;
begin
  if not public.limits_enforced() then return true; end if;

  perform 1 from public.subscriptions where team_id = _team_id for update;

  v_limit := public.team_seat_limit(_team_id);
  if v_limit is null then return true; end if;

  select count(*) into v_used from public.team_members where team_id = _team_id;
  if v_used < v_limit then return true; end if;

  if _invite_id is not null then
    update public.team_invites
       set cancelled_at = now(), cancel_reason = 'no_seats'
     where id = _invite_id and cancelled_at is null
     returning * into v_invite;

    if v_invite.id is not null then
      insert into public.team_notices (team_id, kind, payload)
        values (_team_id, 'invite_cancelled_no_seats', jsonb_build_object(
          'invite_id', v_invite.id,
          'email',     v_invite.email,
          'name',      v_invite.invitee_name,
          'seats',     v_limit));
    end if;
  end if;

  return false;
end;
$$;

-- create_invite gains the invitee's name, for the notice. The two-argument
-- version is dropped rather than left alongside, for the reason 0005 dropped
-- create_team(text): two overloads differing only by a defaulted argument make
-- the call ambiguous to PostgREST. A two-argument call — the app's, and the
-- send-invite function's — still resolves to this one.
drop function if exists public.create_invite(uuid, text);

create or replace function public.create_invite(p_team_id uuid, p_email text, p_name text default '')
returns public.team_invites language plpgsql security definer set search_path = public, auth as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_invite public.team_invites;
begin
  if not public.is_team_admin(p_team_id) then
    raise exception 'Only an owner or admin can invite people to this team';
  end if;
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'That is not an email address';
  end if;
  if exists (
    select 1 from public.team_members m
    join auth.users u on u.id = m.user_id
    where m.team_id = p_team_id and lower(u.email) = v_email
  ) then
    raise exception 'That address is already in this team';
  end if;

  -- Replaces anything outstanding — expired, cancelled or still live — so
  -- re-inviting is always the same call as inviting the first time.
  delete from public.team_invites
   where team_id = p_team_id and lower(email) = v_email and accepted_at is null;

  insert into public.team_invites (team_id, email, invitee_name, invited_by)
    values (p_team_id, v_email, btrim(coalesce(p_name, '')), auth.uid())
    returning * into v_invite;

  return v_invite;
end;
$$;

-- Gains `cancelled`, so the sign-up screen can say why a link stopped working.
-- The return type changes, which create or replace cannot do, hence the drop.
drop function if exists public.invite_preview(uuid);

create or replace function public.invite_preview(p_token uuid)
returns table (email text, team_name text, expired boolean, accepted boolean, cancelled boolean)
language sql security definer set search_path = public as $$
  select i.email, t.name, i.expires_at <= now(), i.accepted_at is not null, i.cancelled_at is not null
  from public.team_invites i
  join public.teams t on t.id = i.team_id
  where i.token = p_token;
$$;

-- Returns {status: 'joined', id, name} or {status: 'full', team_name} instead
-- of the team row; see the section header. The return type changes, hence the
-- drop.
drop function if exists public.accept_invite(uuid);

create or replace function public.accept_invite(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_invite public.team_invites;
  v_team   public.teams;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;

  select * into v_invite from public.team_invites where token = p_token for update;
  if v_invite.id is null then raise exception 'That invitation link is not valid'; end if;
  if v_invite.accepted_at is not null then raise exception 'That invitation has already been used'; end if;
  if v_invite.cancelled_at is not null then
    raise exception 'This team is full. Ask the person who invited you.';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'That invitation has expired. Ask for a new one.';
  end if;
  -- An account with no address (a phone or anonymous sign-in) matches nothing:
  -- without the first test the comparison is NULL and the check passes.
  if v_email is null or lower(v_invite.email) <> v_email then
    raise exception 'That invitation was sent to %, not to you', v_invite.email;
  end if;

  select * into v_team from public.teams where id = v_invite.team_id;

  -- Somebody already in the team takes no new seat.
  if not exists (
    select 1 from public.team_members where team_id = v_invite.team_id and user_id = v_uid
  ) then
    if not public.claim_seat(v_invite.team_id, v_invite.id) then
      return jsonb_build_object('status', 'full', 'team_name', v_team.name);
    end if;
    insert into public.team_members (team_id, user_id, role)
      values (v_invite.team_id, v_uid, v_invite.role)
      on conflict (team_id, user_id) do nothing;
  end if;
  insert into public.member_prefs (team_id, user_id)
    values (v_invite.team_id, v_uid)
    on conflict (team_id, user_id) do nothing;

  update public.team_invites
     set accepted_at = now(), accepted_user_id = v_uid
   where id = v_invite.id;

  return jsonb_build_object('status', 'joined', 'id', v_team.id, 'name', v_team.name);
end;
$$;

-- The same shape as accept_invite. A code has no invitation behind it, so a
-- full team is simply full: nothing to cancel, nobody to tell.
drop function if exists public.join_team(text);

create or replace function public.join_team(p_invite_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_team public.teams;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_team from public.teams where invite_code = upper(trim(p_invite_code));
  if v_team.id is null then raise exception 'Invalid invite code'; end if;

  if not exists (
    select 1 from public.team_members where team_id = v_team.id and user_id = v_uid
  ) then
    if not public.claim_seat(v_team.id) then
      return jsonb_build_object('status', 'full', 'team_name', v_team.name);
    end if;
    -- Always 'member'. Promotion is the owner's call alone.
    insert into public.team_members (team_id, user_id, role)
      values (v_team.id, v_uid, 'member')
      on conflict (team_id, user_id) do nothing;
  end if;
  insert into public.member_prefs (team_id, user_id)
    values (v_team.id, v_uid)
    on conflict (team_id, user_id) do nothing;

  return jsonb_build_object('status', 'joined', 'id', v_team.id, 'name', v_team.name);
end;
$$;

-- 0005's trigger, now asking claim_seat() first and skipping cancelled
-- invitations. Still wrapped so that nothing raised here can roll back the
-- email confirmation itself; a full team cancels the invitation, leaves the
-- notice, and returns without adding anybody.
create or replace function public.consume_invite_on_confirm()
returns trigger language plpgsql security definer set search_path = public, auth as $$
declare
  v_token  uuid;
  v_invite public.team_invites;
begin
  if new.email_confirmed_at is null then return new; end if;

  -- Nested, not `tg_op = 'UPDATE' and old.email_confirmed_at ...` — see 0005.
  if tg_op = 'UPDATE' then
    if old.email_confirmed_at is not null then return new; end if;
  end if;

  begin
    v_token := nullif(new.raw_user_meta_data ->> 'invite_token', '')::uuid;
    if v_token is null then return new; end if;

    select * into v_invite
      from public.team_invites
     where token = v_token and accepted_at is null and cancelled_at is null
       and expires_at > now()
       for update;

    if v_invite.id is null then return new; end if;
    -- The token is not proof by itself. Whoever confirms has to be the address
    -- that was invited, so a leaked link cannot be redeemed by somebody else.
    if new.email is null or lower(v_invite.email) <> lower(new.email) then return new; end if;

    if not exists (
      select 1 from public.team_members where team_id = v_invite.team_id and user_id = new.id
    ) then
      if not public.claim_seat(v_invite.team_id, v_invite.id) then return new; end if;
      insert into public.team_members (team_id, user_id, role)
        values (v_invite.team_id, new.id, v_invite.role)
        on conflict (team_id, user_id) do nothing;
    end if;
    insert into public.member_prefs (team_id, user_id)
      values (v_invite.team_id, new.id)
      on conflict (team_id, user_id) do nothing;

    update public.team_invites
       set accepted_at = now(), accepted_user_id = new.id
     where id = v_invite.id;
  exception when others then
    return new;
  end;

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Onboarding RPCs
-- ─────────────────────────────────────────────────────────────────────────────

/**
 * A team's join code. It is the whole credential for joining the team, so it
 * has to be too long to guess: 12 characters from 32 that cannot be mistaken
 * for one another (no I, O, 0 or 1) is 60 bits. 0001's six hex digits were 24.
 * Bytes 0-5 and 9-14 of a v4 uuid are random, and 256 is a multiple of 32, so
 * every character is equally likely.
 */
create or replace function public.new_join_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_raw  bytea;
  v_code text;
begin
  loop
    v_raw  := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    v_code := '';
    for i in 0..11 loop
      v_code := v_code || substr(v_alphabet,
                  get_byte(v_raw, case when i < 6 then i else i + 3 end) % 32 + 1, 1);
    end loop;
    exit when not exists (select 1 from public.teams where invite_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- 0005's create_team(), unchanged except for the code.
create or replace function public.create_team(p_name text, p_description text default '')
returns public.teams language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_team public.teams;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  insert into public.teams (name, description, invite_code)
    values (coalesce(nullif(trim(p_name), ''), 'My Team'), coalesce(trim(p_description), ''),
            public.new_join_code())
    returning * into v_team;

  -- The creator is the owner, not merely an admin.
  insert into public.team_members (team_id, user_id, role) values (v_team.id, v_uid, 'owner');
  insert into public.member_prefs  (team_id, user_id)       values (v_team.id, v_uid);
  insert into public.team_settings (team_id)                values (v_team.id);
  insert into public.team_templates (team_id, kind)
    values (v_team.id, 'maintenance'), (v_team.id, 'commissioning'), (v_team.id, 'custom');

  return v_team;
end;
$$;

-- Codes made before this file are six hex digits: replace them. Nothing in the
-- app shows or uses a code today (only tests/rls.mjs joins with one, and it
-- reads the code create_team() returns), so nobody has to be told. A re-run
-- finds none left to replace.
update public.teams set invite_code = public.new_join_code() where length(invite_code) < 12;

-- Whether a team has done work under a pack: a visit of one of its workflows.
-- 0007 adds sent reports, which outlive their visits. Internal: it answers for
-- any team id, so only choose_starter_pack() calls it.
-- Made here only if it is not there yet: 0007 gives it its final form, and
-- re-running this file on its own must not take that back.
do $$
begin
  if to_regprocedure('public.pack_in_use(uuid, text)') is null then
    execute $fn$
      create function public.pack_in_use(_team_id uuid, _pack_id text)
      returns boolean language sql stable set search_path = public as $body$
        select exists (
          select 1 from public.visits v
          join public.workflows w on w.id = v.kind
          where v.team_id = _team_id and w.pack_id = _pack_id
        );
      $body$
    $fn$;
  end if;
end $$;

/**
 * Pick the team's one starter pack. Owner or admin, providers only.
 *
 * Swapping is allowed until the team has done any work under the old pack.
 * After that the old pack stays and the other one is an add-on — otherwise a
 * free team could rotate through every pack, a month at a time.
 *
 * A pack the team already holds another way (an add-on, or granted free)
 * cannot also become the starter: there is one row per team and pack, so the
 * swap would delete the old starter and leave the team with none.
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

  -- Locked before the visits are looked at; see gate_visit_pack().
  select pack_id into v_old
    from public.team_packs
   where team_id = p_team_id and source = 'starter'
     for update;

  if v_old = p_pack_id then return; end if;

  if exists (select 1 from public.team_packs where team_id = p_team_id and pack_id = p_pack_id) then
    raise exception 'This team already has the % pack', (select label from public.packs where id = p_pack_id);
  end if;

  if v_old is not null then
    if public.pack_in_use(p_team_id, v_old) then
      raise exception 'This team already has work under its current pack, so it cannot be swapped. Add the other pack instead.'
        using errcode = 'PT402', hint = 'upgrade';
    end if;
    delete from public.team_packs
     where team_id = p_team_id and pack_id = v_old and source = 'starter';
  end if;

  insert into public.team_packs (team_id, pack_id, source)
    values (p_team_id, p_pack_id, 'starter');

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
 *
 * A provider must say which pack it starts with. A new inspecting team never
 * silently gets AV: that fallback lives only in provision_team(), for teams
 * made by today's create_team(), and goes when the new sign-up replaces it.
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
  if p_account_type = 'provider' and nullif(btrim(coalesce(p_pack_id, '')), '') is null then
    raise exception 'Choose the pack this team starts with';
  end if;

  v_team := public.create_team(p_name, p_description);

  update public.teams set account_type = p_account_type
   where id = v_team.id
   returning * into v_team;

  -- provision_team() gave it AV. Clear that and set what was actually chosen.
  delete from public.team_packs where team_id = v_team.id and source = 'starter';
  if p_account_type = 'provider' then
    perform public.choose_starter_pack(v_team.id, p_pack_id);
  end if;

  return v_team;
end;
$$;

/**
 * Open the team's one-time window for importing older work. Owner only.
 *
 * Fifteen minutes from the first call, once per team, ever. Calling it again
 * while the window is still open returns the same closing time, so a botched
 * import can be re-run straight away; after that the answer is PT409 with
 * hint 'import_used'. Inside the window Gate 1 neither checks visit dates nor
 * counts visits started before this month.
 *
 * Owner, not admin: this is the one door through which past dates reach a
 * compliance record, so it is opened by the one person answerable for the team.
 */
create or replace function public.open_import_window(p_team_id uuid)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_until timestamptz;
  v_used  timestamptz;
begin
  if not public.is_team_owner(p_team_id) then
    raise exception 'Only the team''s owner can import older work'
      using errcode = '42501';
  end if;

  select import_open_until, import_used_at into v_until, v_used
    from public.teams where id = p_team_id
     for update;

  if v_used is null then
    update public.teams
       set import_open_until = now() + interval '15 minutes', import_used_at = now()
     where id = p_team_id
     returning import_open_until into v_until;
    return v_until;
  end if;

  if v_until > now() then return v_until; end if;

  raise exception 'This team has already used its one-time import'
    using errcode = 'PT409', hint = 'import_used';
end;
$$;

/**
 * Everything the UI needs to explain a limit before somebody hits it.
 * Members only; NULL limits are unlimited.
 *
 * past_due_until is when a past-due team drops to Free; cancel_at is when a
 * cancelled one does. open_visits is what the plan-ending banner lists.
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
                    ), '[]'::jsonb),
    'past_due_until', (select s.past_due_since + interval '7 days' from public.subscriptions s
                        where s.team_id = p_team_id and s.status = 'past_due'),
    'cancel_at',      (select s.cancel_at from public.subscriptions s where s.team_id = p_team_id),
    'import_used',    (select t.import_used_at is not null from public.teams t where t.id = p_team_id),
    'open_visits',    (select count(*) from public.visits v
                        where v.team_id = p_team_id and v.completed_at is null)
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
alter table public.team_notices  enable row level security;

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

-- Notices: owners and admins read their team's and mark them read. Marking
-- read is the only write, so the privilege is on that one column — the policy
-- says whose rows, the grant says which field. Nobody inserts or deletes.
drop policy if exists team_notices_select on public.team_notices;
create policy team_notices_select on public.team_notices
  for select to authenticated using (public.is_team_admin(team_id));

drop policy if exists team_notices_update on public.team_notices;
create policy team_notices_update on public.team_notices
  for update to authenticated
  using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));

revoke all on table public.team_notices from anon, authenticated;
grant select on table public.team_notices to authenticated;
grant update (read_at) on table public.team_notices to authenticated;

-- The tables from before this file get their second lock too. Supabase's
-- default privileges grant anon everything on every new table: 0002 meant
-- to give it nothing, and 0004 meant authenticated to have nothing on the
-- probe log, but neither revoked. Signed-out pages only call SECURITY DEFINER
-- functions, which need no table privilege.
revoke all on table
  public.teams, public.team_members, public.member_prefs, public.team_settings,
  public.team_templates, public.clients, public.locations, public.floors, public.rooms,
  public.visits, public.visit_rooms, public.visit_exports, public.email_probe_log
from anon;
revoke all on table public.email_probe_log from authenticated;

-- An earlier draft had one visit trigger doing what the three in Gate 1 do.
-- Gone, so a database that ran that draft does not count every visit twice.
drop trigger  if exists visits_gate_start on public.visits;
drop function if exists public.gate_visit_start();

-- Trigger functions and internal helpers: nobody calls these directly.
revoke execute on function public.provision_team()                    from public, anon, authenticated;
revoke execute on function public.track_past_due()                    from public, anon, authenticated;
revoke execute on function public.gate_visit_pack()                   from public, anon, authenticated;
revoke execute on function public.gate_visit_dates()                  from public, anon, authenticated;
revoke execute on function public.count_visit_start()                 from public, anon, authenticated;
revoke execute on function public.gate_team_seats()                   from public, anon, authenticated;
revoke execute on function public.gate_team_invites()                 from public, anon, authenticated;
revoke execute on function public.import_window_open(uuid)            from public, anon, authenticated;
revoke execute on function public.check_visit_date(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_seat(uuid, uuid)              from public, anon, authenticated;
revoke execute on function public.count_inspection(uuid)              from public, anon, authenticated;
revoke execute on function public.count_imported_visit()              from public, anon, authenticated;
revoke execute on function public.check_visit_not_future(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.new_join_code()                     from public, anon, authenticated;
revoke execute on function public.gate_visit_identity()               from public, anon, authenticated;
revoke execute on function public.check_visit_order(timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.pack_in_use(uuid, text)             from public, anon, authenticated;

-- Helpers that answer the same for everybody, so policies and SECURITY INVOKER
-- code in 0007 can call them as the signed-in user; `anon` has no use for them.
revoke execute on function public.local_day(timestamptz)        from public, anon;
revoke execute on function public.limits_enforced()             from public, anon;
grant  execute on function public.limits_enforced()             to authenticated;
-- The plan helpers answer for any team id they are given, so only the
-- database's own functions call them; 0007's evidence policy asks
-- can_add_evidence(), which answers for the caller's own teams only.
revoke execute on function public.team_is_pro(uuid)             from public, anon, authenticated;
revoke execute on function public.team_seat_limit(uuid)         from public, anon, authenticated;
revoke execute on function public.team_visit_limit(uuid)        from public, anon, authenticated;
revoke execute on function public.team_has_pack(uuid, text)     from public, anon, authenticated;
grant  execute on function public.local_day(timestamptz)        to authenticated;

revoke execute on function public.choose_starter_pack(uuid, text)               from public, anon;
revoke execute on function public.create_organisation(text, text, text, text)   from public, anon;
revoke execute on function public.team_entitlements(uuid)                       from public, anon;
revoke execute on function public.open_import_window(uuid)                      from public, anon;
revoke execute on function public.create_invite(uuid, text, text)               from public, anon;
revoke execute on function public.accept_invite(uuid)                           from public, anon;
revoke execute on function public.join_team(text)                               from public, anon;
grant  execute on function public.choose_starter_pack(uuid, text)               to authenticated;
grant  execute on function public.create_organisation(text, text, text, text)   to authenticated;
grant  execute on function public.team_entitlements(uuid)                       to authenticated;
grant  execute on function public.open_import_window(uuid)                      to authenticated;
grant  execute on function public.create_invite(uuid, text, text)               to authenticated;
grant  execute on function public.accept_invite(uuid)                           to authenticated;
grant  execute on function public.join_team(text)                               to authenticated;
-- anon as well, as in 0005: it is read before there is an account.
grant  execute on function public.invite_preview(uuid)                          to anon, authenticated;

-- PostgREST caches the schema; without this the new functions 404 until the
-- next restart.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification. Expected: packs 5, workflows 9, fixed_intervals 3,
-- teams_without_plan 0, kind_fkeys 2, gates 8, notices_locked 1, and enforced
-- false until you turn it on. The second result lists every team with its
-- plan — the ones that existed before this file should read pro / comped / av.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select enforce_limits from public.app_settings)                          as enforced,
  (select count(*) from public.packs)                                        as packs,
  (select count(*) from public.workflows)                                    as workflows,
  (select count(*) from public.workflows where interval_fixed)               as fixed_intervals,
  (select count(*) from public.teams t
    where not exists (select 1 from public.subscriptions s where s.team_id = t.id))
                                                                             as teams_without_plan,
  (select count(*) from pg_constraint
    where conname in ('visits_kind_fkey', 'team_templates_kind_fkey'))       as kind_fkeys,
  (select count(*) from pg_trigger
    where not tgisinternal and tgname in ('teams_provision', 'visits_gate_pack',
                                          'visits_gate_dates', 'visits_count_start',
                                          'team_members_gate_seats', 'team_invites_gate_seats',
                                          'visits_gate_identity', 'visits_count_import'))
                                                                             as gates,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'team_notices'
      and c.relrowsecurity)                                                  as notices_locked;

select t.name, t.account_type, s.plan, s.comped,
       coalesce(string_agg(p.pack_id || ' (' || p.source || ')', ', ' order by p.pack_id), '') as packs
  from public.teams t
  join public.subscriptions s on s.team_id = t.id
  left join public.team_packs p on p.team_id = t.id
 group by t.name, t.account_type, s.plan, s.comped
 order by t.name;
