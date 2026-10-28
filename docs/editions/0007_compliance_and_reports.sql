-- Pemcora — equipment, re-check dates, photo evidence, and reports that reach the landlord.
-- Run in the Supabase SQL editor after 0006_editions.sql. Safe to re-run.
--
-- Select nothing before running: the editor executes only the highlighted text
-- if anything is selected, which silently runs a fragment of this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What this adds
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0006 decided who may do what. This is the field data the new editions need,
-- and every piece of it is shared by all of them rather than built per trade:
--
--   assets            — the equipment at a site: smoke alarms, RCDs, switchboards,
--                       displays, codecs. An alarm's expiry date lives here, so
--                       next year's visit already knows it.
--   compliance_items  — what a site owes and when it is next due. A completed
--                       visit moves the date on by itself. This is the "due for
--                       re-check" list that brings an electrician repeat work, and
--                       the same table is a landlord's compliance tracker.
--   workflow_intervals — how often a team wants a check it may choose the cadence
--                       of: a team default, and per-client overrides. Regular AV
--                       PM visits live here.
--   attachments       — photo evidence against a test. Pro.
--   report_deliveries — a finished report sent from a provider to a landlord or
--                       agency, frozen at the moment it was sent.
--   site_links        — "this provider's site is that landlord's property", so
--                       the second report files itself.
--
-- Plus a few columns on existing tables, all with defaults that leave every
-- existing row reading exactly as it did.
--
-- The one hard boundary in this file is between teams. A provider's clients,
-- visits and notes stay the provider's: a landlord never gets read access to
-- any of those tables. What crosses over is a delivery — a snapshot plus one
-- file — through SECURITY DEFINER functions that check both ends. The same
-- reason 0001 snapshots a template into each room: work that has been signed
-- off and handed over must not change because somebody edits something later.

-- ─────────────────────────────────────────────────────────────────────────────
-- New columns on existing tables
-- ─────────────────────────────────────────────────────────────────────────────

-- Who to send the report and the re-check reminder to, and whether to remind
-- them at all. Reminders can be switched off for the whole team (admins, on
-- team_settings), for one client, and for one check (compliance_items); all
-- three default to on, and any one of them off means no email.
alter table public.clients
  add column if not exists contact_name      text    not null default '',
  add column if not exists contact_email     text    not null default '',
  add column if not exists contact_phone     text    not null default '',
  add column if not exists reminders_enabled boolean not null default true;

-- team_settings is admin-only to write (0001), which is who may switch
-- reminders off for everybody.
alter table public.team_settings
  add column if not exists reminders_enabled boolean not null default true;

-- Each technician's own licence or registration number, printed on their
-- reports. The business's licence and REC numbers go in team_settings.company
-- (licence_number, rec_number) — it is JSON, so no column.
alter table public.member_prefs
  add column if not exists licence_number text not null default '';

-- Which rules apply to a site. A house is a location like any other: its
-- storeys are floors and its bedrooms and hallways are rooms, which is exactly
-- the shape smoke alarm rules are written in.
alter table public.locations
  add column if not exists site_type text    not null default 'commercial',
  add column if not exists is_rental boolean not null default false;

-- 'bedroom', 'hallway', 'meter_box', 'meeting_room' … — keys from the pack in
-- src/data/, used to switch on the right sections and to check coverage
-- ("every bedroom has an alarm"). Free text here on purpose: packs add types.
alter table public.rooms
  add column if not exists room_type text not null default '';

-- site_results: sections that happen once per visit rather than once per room
-- — the switchboard and RCD tests, the interconnection test, the declaration.
-- Same shape as a room: { template, results, readings, troubleshooting, comments }.
-- outcome: the certificate's verdict, declared by the technician at sign-off.
-- It is not derived from FAIL counts, because a fault rectified on the spot is
-- a FAIL in the log and still a compliant property.
-- signoff: { technician, licence_number, signed_at, signature }, captured when
-- the technician signs off and kept with the visit, so changing a name or
-- licence number in Settings later never rewrites a signed report. The
-- signature is an SVG path; under 50 KB, and on Free as well as Pro because it
-- lives in the row, not in the photo bucket.
alter table public.visits
  add column if not exists site_results jsonb not null default '{}'::jsonb,
  add column if not exists outcome      text,
  add column if not exists signoff      jsonb;

-- Measured values beside the PASS/FAIL verdicts: insulation resistance, RCD
-- trip times, earth continuity. Keyed like results, so a verdict and its
-- reading always line up.
alter table public.visit_rooms
  add column if not exists readings jsonb not null default '{}'::jsonb;

-- Where a result is stored. No column changes: it is all jsonb, and this is
-- the shape the app writes and every reader (export, report, snapshot) reads.
--
--   ordinary section, in a room      visit_rooms.results[sectionId][testId]
--   repeated per item, in a room     visit_rooms.results[sectionId][assetId][testId]
--   repeated per item, whole site    visits.site_results.results[sectionId][assetId][testId]
--
-- Readings follow the same paths under `readings`, each value { value, unit }.
-- A section repeated per item (each RCD, each smoke alarm) keys its results by
-- the asset's id, so results follow the item from visit to visit. The template
-- snapshot stored beside the results records each section's scope — 'room',
-- 'site', or 'item' with its assetType — which is how a reader knows which of
-- these shapes a section uses.

-- Constraints separately, as in 0003: `add column if not exists` skips the whole
-- clause when the column is already there.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'locations_site_type_check') then
    alter table public.locations
      add constraint locations_site_type_check check (site_type in ('commercial', 'residential'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'visits_outcome_check') then
    alter table public.visits
      add constraint visits_outcome_check
      check (outcome is null or outcome in ('compliant', 'non_compliant'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'visits_signoff_check') then
    alter table public.visits
      add constraint visits_signoff_check
      check (signoff is null
             or (jsonb_typeof(signoff) = 'object'
                 and octet_length(coalesce(signoff ->> 'signature', '')) <= 51200));
  end if;
end $$;

-- The sign-off is the app's, but who and when are the database's: whenever it
-- is written, signed_by becomes whoever is signed in and recorded_at the
-- moment it was saved, over anything the app sent under those keys. signed_at
-- stays the app's — the moment of signing, which may have been offline — but
-- it cannot be in the future or before the visit started, and the database
-- fills it in if the app left it out. Sending the same sign-off back is not a
-- change, and keeps both stamps.
create or replace function public.stamp_signoff()
returns trigger language plpgsql set search_path = public as $$
declare v_signed timestamptz;
begin
  if new.signoff is null then return new; end if;
  -- Nested, not `tg_op = 'UPDATE' and old.signoff ...` — see 0005.
  if tg_op = 'UPDATE' then
    if new.signoff is not distinct from old.signoff then return new; end if;
  end if;

  v_signed := coalesce((new.signoff ->> 'signed_at')::timestamptz, now());
  if v_signed > now() + interval '1 hour' or v_signed < new.started_at - interval '1 hour' then
    raise exception 'The sign-off time has to fall between the start of the visit and now'
      using errcode = 'check_violation', hint = 'signoff_date';
  end if;

  new.signoff := new.signoff || jsonb_build_object(
    'signed_at', v_signed, 'signed_by', auth.uid(), 'recorded_at', now());
  return new;
end;
$$;

drop trigger if exists visits_stamp_signoff on public.visits;
create trigger visits_stamp_signoff before insert or update of signoff on public.visits
  for each row execute function public.stamp_signoff();

-- ─────────────────────────────────────────────────────────────────────────────
-- Equipment register
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A site's equipment, optionally pinned to a room. attributes holds whatever
-- the pack defines for that asset_type — for a smoke alarm: sensor type,
-- standard marking, power source, interconnected — so a new pack adds fields
-- without adding columns.
--
-- Removed, never deleted, so history keeps pointing at the alarm it tested. A
-- room deleted from the plan leaves its equipment at the site rather than
-- taking it with it.

create table if not exists public.assets (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references public.teams(id) on delete cascade,
  location_id  uuid not null references public.locations(id) on delete cascade,
  room_id      uuid references public.rooms(id) on delete set null,
  asset_type   text not null,
  label        text not null default '',
  make         text not null default '',
  model        text not null default '',
  serial       text not null default '',
  attributes   jsonb not null default '{}'::jsonb,
  installed_on date,
  expires_on   date,   -- smoke alarms: ten years from manufacture
  removed_at   timestamptz,
  expiry_reminded_at timestamptz,   -- when the reminder job last mentioned the expiry
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists assets_location_idx on public.assets(location_id);
create index if not exists assets_team_idx     on public.assets(team_id);
create index if not exists assets_expiry_idx   on public.assets(team_id, expires_on)
  where removed_at is null and expires_on is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Report deliveries
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Everything a landlord will ever see of a provider's work is in this row and
-- the one file it names. It outlives the visit it came from: a provider tidying
-- up old clients must not delete a landlord's evidence that a check was done,
-- so every reference back to the provider's side is ON DELETE SET NULL.
--
--   site      — the address, copied from the provider's location by the server.
--               What claiming matches a property on, so it is never taken from
--               the client.
--   snapshot  — the report as sent, written by the provider's app. The server
--               adds the provider's own name and company details, and the
--               technician's sign-off from the visit row, over the top — so a
--               report always says truthfully which team it came from and who
--               signed it.
--   token     — the credential in the emailed link, as with team_invites.
--   link_expires_at — the link's public view ends here (90 days). Saving the
--               report to an account never expires; it needs a sign-in with
--               the address it was sent to. "Send again" issues a new token.

create table if not exists public.report_deliveries (
  id                    uuid primary key default gen_random_uuid(),
  provider_team_id      uuid references public.teams(id) on delete set null,
  visit_id              uuid references public.visits(id) on delete set null,
  provider_location_id  uuid references public.locations(id) on delete set null,
  workflow_id           text not null references public.workflows(id),
  completed_on          date not null,
  outcome               text,
  site                  jsonb not null default '{}'::jsonb,
  snapshot              jsonb not null default '{}'::jsonb,
  file_path             text,   -- object name in the 'reports' bucket
  recipient_email       text not null,
  token                 uuid not null default gen_random_uuid(),
  link_expires_at       timestamptz not null default now() + interval '90 days',
  sent_by               uuid references auth.users(id) on delete set null,
  sent_at               timestamptz not null default now(),
  opened_at             timestamptz,
  recipient_team_id     uuid references public.teams(id) on delete set null,
  recipient_location_id uuid references public.locations(id) on delete set null,
  claimed_by            uuid references auth.users(id) on delete set null,
  claimed_at            timestamptz,
  filed_at              timestamptz
);
create unique index if not exists report_deliveries_token_idx     on public.report_deliveries(token);
create index        if not exists report_deliveries_provider_idx  on public.report_deliveries(provider_team_id);
create index        if not exists report_deliveries_recipient_idx on public.report_deliveries(recipient_team_id);
create index        if not exists report_deliveries_email_idx     on public.report_deliveries(lower(recipient_email));

-- Remembered after the first filing, so the next report for the same site goes
-- straight into the same property. Either side can see it; the landlord can
-- remove it to stop auto-filing.
create table if not exists public.site_links (
  provider_location_id  uuid not null references public.locations(id) on delete cascade,
  recipient_team_id     uuid not null references public.teams(id) on delete cascade,
  provider_team_id      uuid not null references public.teams(id) on delete cascade,
  recipient_location_id uuid not null references public.locations(id) on delete cascade,
  created_at            timestamptz not null default now(),
  primary key (provider_location_id, recipient_team_id)
);
create index if not exists site_links_recipient_idx on public.site_links(recipient_team_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Compliance items: what a site owes, and when it is next due
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One row per site per obligation. The same table serves both sides:
--
--   provider — "12 Smith St is due its electrical check in March": the re-check
--              list and the reminder that brings the job back.
--   landlord — every obligation across every property, including the ones no
--              Pemcora provider does (a gas check by a gasfitter, recorded by
--              hand with its certificate in evidence_path).
--
-- obligation is a key from the pack — a workflow id where Pemcora has one.
-- label is stored so a reminder email can be written without the app's code.
-- satisfied_by says which visit kind completes it; NULL means by hand or by a
-- delivered report.
--
-- reminder_token is the credential behind a reminder email's "No longer
-- needed" link: reminder_opt_out() switches that one check's reminders off
-- without a sign-in, and records when and how (opted_out_at, opted_out_via).

create table if not exists public.compliance_items (
  id                 uuid primary key default gen_random_uuid(),
  team_id            uuid not null references public.teams(id) on delete cascade,
  location_id        uuid not null references public.locations(id) on delete cascade,
  obligation         text not null,
  label              text not null,
  satisfied_by       text references public.workflows(id),
  interval_months    int  not null check (interval_months between 1 and 120),
  last_done_on       date,
  next_due_on        date,
  last_visit_id      uuid references public.visits(id) on delete set null,
  last_delivery_id   uuid references public.report_deliveries(id) on delete set null,
  evidence_path      text,   -- object name in the 'evidence' bucket
  remind_days_before int  not null default 30 check (remind_days_before between 0 and 365),
  last_reminded_at   timestamptz,
  reminders_enabled  boolean not null default true,
  reminder_token     uuid not null unique default gen_random_uuid(),
  opted_out_at       timestamptz,
  opted_out_via      text,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (location_id, obligation)
);
create index if not exists compliance_items_team_idx on public.compliance_items(team_id);
create index if not exists compliance_items_due_idx  on public.compliance_items(team_id, next_due_on) where active;

-- ─────────────────────────────────────────────────────────────────────────────
-- Regular intervals: how often a team wants a check it can choose
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One team default per workflow (client_id NULL) and at most one override per
-- client. A client's own interval beats the team default for that client's
-- sites only; with neither, the workflow's own default applies, and AV PM has
-- none. Workflows whose interval the law sets (interval_fixed) never get a row.
--
-- Read by every member; written only through set_workflow_interval(), which
-- is admin-only and also brings the sites' due dates into line.

create table if not exists public.workflow_intervals (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references public.teams(id) on delete cascade,
  workflow_id     text not null references public.workflows(id),
  client_id       uuid references public.clients(id) on delete cascade,
  interval_months int  not null check (interval_months between 1 and 120),
  updated_at      timestamptz not null default now()
);
create unique index if not exists workflow_intervals_team_default_idx
  on public.workflow_intervals(team_id, workflow_id) where client_id is null;
create unique index if not exists workflow_intervals_client_idx
  on public.workflow_intervals(team_id, workflow_id, client_id) where client_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Photo evidence (Pro)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.attachments (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null references public.teams(id) on delete cascade,
  visit_id      uuid references public.visits(id) on delete cascade,
  visit_room_id uuid references public.visit_rooms(id) on delete cascade,
  asset_id      uuid references public.assets(id) on delete set null,
  test_id       text,   -- the template test this photo is evidence for
  storage_path  text not null unique,   -- '<team_id>/…' in the 'evidence' bucket
  caption       text not null default '',
  taken_at      timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null
);
create index if not exists attachments_visit_idx on public.attachments(visit_id);
create index if not exists attachments_team_idx  on public.attachments(team_id);

do $$
declare t text;
begin
  foreach t in array array['assets', 'compliance_items', 'workflow_intervals'] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- How often a check recurs at a site
-- ─────────────────────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER, both: RLS lets a member read their own team's intervals
-- and sites, and nobody else's.

-- The interval a team has chosen for a workflow at one client's sites: the
-- client's own, else the team default. NULL when the team has chosen none.
create or replace function public.team_interval(_team_id uuid, _workflow_id text, _client_id uuid)
returns int language sql stable set search_path = public as $$
  select coalesce(
    (select wi.interval_months from public.workflow_intervals wi
      where wi.team_id = _team_id and wi.workflow_id = _workflow_id and wi.client_id = _client_id),
    (select wi.interval_months from public.workflow_intervals wi
      where wi.team_id = _team_id and wi.workflow_id = _workflow_id and wi.client_id is null));
$$;

-- The interval that actually applies at a site: the client override, else the
-- team default, else the workflow's own default. The law's interval always
-- wins for a fixed workflow. NULL means the check does not recur there.
create or replace function public.effective_interval(_team_id uuid, _workflow_id text, _location_id uuid)
returns int language sql stable set search_path = public as $$
  select case
    when w.interval_fixed then w.default_interval_months
    else coalesce(
      public.team_interval(_team_id, _workflow_id,
                           (select l.client_id from public.locations l where l.id = _location_id)),
      w.default_interval_months)
  end
    from public.workflows w
   where w.id = _workflow_id;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Due dates work themselves out
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A check entered by hand — a landlord recording a gas check, say — gets its
-- next due date the same way a visit's does: when last_done_on is set or
-- changes, or interval_months changes, next_due_on becomes last_done_on plus
-- the interval and the reminder cycle starts again. Unless next_due_on was set
-- in the same write: advance_compliance(), _file_delivery() and
-- set_workflow_interval() set both dates themselves, and a person may type a
-- due date the law gives them.

create or replace function public.compliance_next_due()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.last_done_on is null then return new; end if;

  if tg_op = 'INSERT' then
    if new.next_due_on is null then
      new.next_due_on      := (new.last_done_on + make_interval(months => new.interval_months))::date;
      new.last_reminded_at := null;
    end if;
    return new;
  end if;

  if new.next_due_on is distinct from old.next_due_on then return new; end if;
  if new.last_done_on is distinct from old.last_done_on
     or new.interval_months is distinct from old.interval_months then
    new.next_due_on      := (new.last_done_on + make_interval(months => new.interval_months))::date;
    new.last_reminded_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists compliance_items_next_due on public.compliance_items;
create trigger compliance_items_next_due before insert or update on public.compliance_items
  for each row execute function public.compliance_next_due();

-- A client who switched a check's reminders off from the email stays switched
-- off: the team cannot turn them back on. A working unsubscribe is the law for
-- emails like these (Spam Act 2003), and the record of it is not the team's to
-- edit either — opted_out_at and opted_out_via have no client grant (see the
-- privileges below). A check the team switched off itself, from the Due page,
-- can be switched back on.
create or replace function public.keep_opt_out()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.reminders_enabled and new.opted_out_via = 'email_link' then
    raise exception 'The client turned these reminders off from the email, so they cannot be turned back on here'
      using errcode = 'check_violation', hint = 'opted_out';
  end if;
  return new;
end;
$$;

drop trigger if exists compliance_items_keep_opt_out on public.compliance_items;
create trigger compliance_items_keep_opt_out before update of reminders_enabled, opted_out_via
  on public.compliance_items
  for each row execute function public.keep_opt_out();

-- ─────────────────────────────────────────────────────────────────────────────
-- A completed visit moves its site's due dates on
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The first time a recurring workflow is completed at a site — one with an
-- interval there, from the law, the workflow's default, or the team's own
-- choice (effective_interval) — that site gets its compliance item; every
-- completion after moves next_due_on forward. Nobody has to set up a schedule
-- for the re-check list to exist, and a site added after the team chose a
-- regular PM interval joins it on its first PM visit.
--
-- AFTER INSERT as well as UPDATE, so visits imported already completed build
-- the schedule too. Never backwards: completing an older visit late does not
-- pull a newer due date back. Reopening a visit does not undo anything, and
-- completing it again moves nothing on: it keeps the date it was first
-- completed (0006), so it is a correction, not another inspection.
--
-- SECURITY DEFINER because the reminder bookkeeping it resets
-- (last_reminded_at, last_visit_id) is not the client's to write; see the
-- column grants on compliance_items below. It touches only the items of the
-- visit's own team at the visit's own site, and the visit row has already
-- passed the parent check that keeps that site in the same team.

create or replace function public.advance_compliance()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_done     date;
  v_interval int;
  v_label    text;
begin
  if new.completed_at is null then return new; end if;
  -- Nested, not `tg_op = 'UPDATE' and old.completed_at ...` — see 0005.
  if tg_op = 'UPDATE' then
    if old.completed_at is not null then return new; end if;
    if old.first_completed_at is not null then return new; end if;
  end if;

  v_done     := public.local_day(new.completed_at);
  v_interval := public.effective_interval(new.team_id, new.kind, new.location_id);
  select w.label into v_label from public.workflows w where w.id = new.kind;

  if v_interval is not null then
    insert into public.compliance_items
      (team_id, location_id, obligation, label, satisfied_by, interval_months)
    values (new.team_id, new.location_id, new.kind, v_label, new.kind, v_interval)
    on conflict (location_id, obligation) do nothing;
  end if;

  update public.compliance_items c
     set last_done_on     = v_done,
         next_due_on      = (v_done + make_interval(months => c.interval_months))::date,
         last_visit_id    = new.id,
         last_reminded_at = null
   where c.location_id = new.location_id
     and c.team_id = new.team_id
     and c.satisfied_by = new.kind
     and c.active
     and (c.last_done_on is null or c.last_done_on <= v_done);

  return new;
end;
$$;

drop trigger if exists visits_advance_compliance on public.visits;
create trigger visits_advance_compliance after insert or update of completed_at on public.visits
  for each row execute function public.advance_compliance();

/**
 * Set how often a check is done: the team default (p_client_id NULL) or one
 * client's own (overriding the default for that client's sites only). NULL
 * months removes it — for a client, "use the team default". Owner or admin.
 *
 * Refuses workflows whose interval the law sets. Then brings every site in
 * scope into line: each gets its compliance item, due from the last completed
 * visit of that workflow (no due date — "not done yet" — if there is none),
 * and a site left with no interval at all has its item switched off.
 */
create or replace function public.set_workflow_interval(
  p_team_id     uuid,
  p_workflow_id text,
  p_client_id   uuid,
  p_months      int
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_label      text;
  v_fixed      boolean;
  v_loc        record;
  v_interval   int;
  v_last_day   date;
  v_last_visit uuid;
begin
  if not public.is_team_admin(p_team_id) then
    raise exception 'Only an owner or admin can set how often a check is done';
  end if;

  select w.label, w.interval_fixed into v_label, v_fixed
    from public.workflows w where w.id = p_workflow_id;
  if v_label is null then
    raise exception 'There is no workflow called "%"', p_workflow_id;
  end if;
  if v_fixed then
    raise exception 'How often the % is done is set by law, so it cannot be changed', lower(v_label);
  end if;
  if p_client_id is not null
     and not exists (select 1 from public.clients c where c.id = p_client_id and c.team_id = p_team_id) then
    raise exception 'That client is not in this team';
  end if;
  if p_months is not null and p_months not between 1 and 120 then
    raise exception 'An interval is between 1 and 120 months';
  end if;

  if p_months is null then
    delete from public.workflow_intervals
     where team_id = p_team_id and workflow_id = p_workflow_id
       and client_id is not distinct from p_client_id;
  elsif p_client_id is null then
    insert into public.workflow_intervals (team_id, workflow_id, client_id, interval_months)
      values (p_team_id, p_workflow_id, null, p_months)
      on conflict (team_id, workflow_id) where client_id is null
      do update set interval_months = excluded.interval_months;
  else
    insert into public.workflow_intervals (team_id, workflow_id, client_id, interval_months)
      values (p_team_id, p_workflow_id, p_client_id, p_months)
      on conflict (team_id, workflow_id, client_id) where client_id is not null
      do update set interval_months = excluded.interval_months;
  end if;

  for v_loc in
    select l.id from public.locations l
     where l.team_id = p_team_id and (p_client_id is null or l.client_id = p_client_id)
  loop
    v_interval := public.effective_interval(p_team_id, p_workflow_id, v_loc.id);

    if v_interval is null then
      update public.compliance_items
         set active = false
       where location_id = v_loc.id and obligation = p_workflow_id and active;
      continue;
    end if;

    select v.id, public.local_day(v.completed_at) into v_last_visit, v_last_day
      from public.visits v
     where v.location_id = v_loc.id and v.team_id = p_team_id
       and v.kind = p_workflow_id and v.completed_at is not null
     order by v.completed_at desc
     limit 1;

    insert into public.compliance_items
      (team_id, location_id, obligation, label, satisfied_by, interval_months)
    values (p_team_id, v_loc.id, p_workflow_id, v_label, p_workflow_id, v_interval)
    on conflict (location_id, obligation) do nothing;

    -- greatest() skips NULLs: a later date already on the item (entered by
    -- hand, say) is kept rather than pulled back to the last visit.
    update public.compliance_items c
       set interval_months  = v_interval,
           satisfied_by     = p_workflow_id,
           active           = true,
           last_done_on     = greatest(c.last_done_on, v_last_day),
           last_visit_id    = case when v_last_day is not null
                                    and (c.last_done_on is null or v_last_day >= c.last_done_on)
                                   then v_last_visit else c.last_visit_id end,
           next_due_on      = (greatest(c.last_done_on, v_last_day)
                               + make_interval(months => v_interval))::date,
           last_reminded_at = case when (greatest(c.last_done_on, v_last_day)
                                         + make_interval(months => v_interval))::date
                                        is distinct from c.next_due_on
                                   then null else c.last_reminded_at end
     where c.location_id = v_loc.id and c.obligation = p_workflow_id;
  end loop;
end;
$$;

-- Photos are a Pro feature. Checked on the row as well as on the upload (see
-- the storage policies), so neither can be had without the other. Like every
-- limit in 0006, only once app_settings.enforce_limits is on.
create or replace function public.gate_attachment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.limits_enforced() and not public.team_is_pro(new.team_id) then
    raise exception 'Photo evidence is part of Pro'
      using errcode = 'PT402', hint = 'upgrade';
  end if;
  return new;
end;
$$;

drop trigger if exists attachments_gate on public.attachments;
create trigger attachments_gate before insert on public.attachments
  for each row execute function public.gate_attachment();

-- ─────────────────────────────────────────────────────────────────────────────
-- Delivering a report
-- ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal. Put a delivery into a recipient team's property, remember the link
 * between the two sites, and move that property's due date on.
 *
 * Not callable by any client — the four public functions below check who is
 * asking, and this assumes they have.
 */
create or replace function public._file_delivery(
  p_delivery_id uuid,
  p_team_id     uuid,
  p_location_id uuid,
  p_user_id     uuid
)
returns public.report_deliveries language plpgsql security definer set search_path = public as $$
declare
  v_row      public.report_deliveries;
  v_interval int;
  v_label    text;
begin
  update public.report_deliveries
     set recipient_team_id     = p_team_id,
         recipient_location_id = p_location_id,
         claimed_by            = coalesce(claimed_by, p_user_id),
         claimed_at            = coalesce(claimed_at, now()),
         filed_at              = case when p_location_id is null then filed_at else now() end
   where id = p_delivery_id
   returning * into v_row;

  if p_location_id is null then return v_row; end if;

  if v_row.provider_team_id is not null and v_row.provider_location_id is not null then
    insert into public.site_links
      (provider_location_id, recipient_team_id, provider_team_id, recipient_location_id)
    values (v_row.provider_location_id, p_team_id, v_row.provider_team_id, p_location_id)
    on conflict (provider_location_id, recipient_team_id)
      do update set recipient_location_id = excluded.recipient_location_id;
  end if;

  select w.default_interval_months, w.label into v_interval, v_label
    from public.workflows w where w.id = v_row.workflow_id;

  if v_interval is not null then
    insert into public.compliance_items (team_id, location_id, obligation, label, interval_months)
    values (p_team_id, p_location_id, v_row.workflow_id, v_label, v_interval)
    on conflict (location_id, obligation) do nothing;
  end if;

  update public.compliance_items c
     set last_done_on     = v_row.completed_on,
         next_due_on      = (v_row.completed_on + make_interval(months => c.interval_months))::date,
         last_delivery_id = v_row.id,
         last_reminded_at = null
   where c.location_id = p_location_id
     and c.obligation = v_row.workflow_id
     and c.active
     and (c.last_done_on is null or c.last_done_on <= v_row.completed_on);

  return v_row;
end;
$$;

/**
 * Send a completed visit's report to somebody's email address. Any member of
 * the visit's team.
 *
 * The caller is the deliver-report Edge Function, using the member's own JWT
 * exactly as send-invite does — so this function is the only place the rules
 * live. It returns the row, token included; the function emails the link.
 *
 * Free teams can send too. Every report sent brings a landlord to Pemcora, and
 * the free allowance is already counted when the visit starts.
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
 * Withdraw a report sent to the wrong address. Provider's team, and only until
 * somebody has claimed it — after that it is the recipient's record.
 */
create or replace function public.revoke_report(p_delivery_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_row public.report_deliveries;
begin
  select * into v_row from public.report_deliveries where id = p_delivery_id for update;
  if v_row.id is null or not public.is_team_member(v_row.provider_team_id) then
    raise exception 'That report was not sent by your team';
  end if;
  if v_row.claimed_at is not null then
    raise exception 'That report has already been saved by its recipient, so it can no longer be withdrawn';
  end if;
  delete from public.report_deliveries where id = p_delivery_id;
end;
$$;

-- 0006's pack_in_use(), plus sent reports. A report stays the team's record
-- after its visit is deleted, so it is work under the pack as much as the
-- visit was: deleting visits no longer frees the starter pack for a swap.
create or replace function public.pack_in_use(_team_id uuid, _pack_id text)
returns boolean language sql stable set search_path = public as $$
  select exists (
           select 1 from public.visits v
           join public.workflows w on w.id = v.kind
           where v.team_id = _team_id and w.pack_id = _pack_id)
      or exists (
           select 1 from public.report_deliveries d
           join public.workflows w on w.id = d.workflow_id
           where d.provider_team_id = _team_id and w.pack_id = _pack_id);
$$;

/**
 * What a report link shows, to anyone holding it — signed in or not. The link
 * is the credential, as an emailed PDF would be. Marks the report opened.
 *
 * status says which page to show:
 *   ok      — the report itself. The only status that returns its content.
 *   expired — the 90 days are up: just the provider's name, to ask for a new link.
 *   saved   — somebody saved it to their account: just the provider's name, and
 *             the page asks them to sign in. It stays saved if that account is
 *             later deleted, rather than opening to the link again.
 * The Edge Function that signs the file's short-lived URL for a visitor without
 * an account gives one only for 'ok'.
 *
 * Never returns the recipient's address or any provider-side id (the team in
 * the provider block, the account in the sign-off). The return type gains
 * status, which create or replace cannot do, hence the drop.
 */
drop function if exists public.report_preview(uuid);

create or replace function public.report_preview(p_token uuid)
returns table (
  status       text,
  workflow     text,
  provider     text,
  completed_on date,
  outcome      text,
  site         jsonb,
  snapshot     jsonb,
  has_file     boolean,
  claimed      boolean
)
language plpgsql security definer set search_path = public as $$
begin
  update public.report_deliveries d
     set opened_at = coalesce(d.opened_at, now())
   where d.token = p_token;

  return query
    select s.status,
           case when s.status = 'ok' then w.label end,
           d.snapshot #>> '{provider,name}',
           case when s.status = 'ok' then d.completed_on end,
           case when s.status = 'ok' then d.outcome end,
           case when s.status = 'ok' then d.site end,
           case when s.status = 'ok' then d.snapshot #- '{provider,team_id}' #- '{signoff,signed_by}' end,
           case when s.status = 'ok' then d.file_path is not null end,
           d.recipient_team_id is not null or d.claimed_at is not null
      from public.report_deliveries d
      join public.workflows w on w.id = d.workflow_id
      cross join lateral (
        select case
                 when d.recipient_team_id is not null or d.claimed_at is not null then 'saved'
                 when d.link_expires_at <= now()      then 'expired'
                 else 'ok'
               end as status
      ) s
     where d.token = p_token;
end;
$$;

/**
 * "Send again": a fresh link for a report this team sent, with a new 90 days.
 * The old link stops working at once, because the token is what it was. Returns
 * the row, new token included, for the Edge Function to email.
 *
 * The report itself does not change — only the way in to it.
 */
create or replace function public.resend_report(p_delivery_id uuid)
returns public.report_deliveries language plpgsql security definer set search_path = public as $$
declare v_row public.report_deliveries;
begin
  select * into v_row from public.report_deliveries where id = p_delivery_id for update;
  if v_row.id is null or not public.is_team_member(v_row.provider_team_id) then
    raise exception 'That report was not sent by your team';
  end if;

  update public.report_deliveries
     set token = gen_random_uuid(), link_expires_at = now() + interval '90 days'
   where id = p_delivery_id
   returning * into v_row;

  return v_row;
end;
$$;

/**
 * Save a report into one of your landlord or agency teams. The address has to
 * be the one it was sent to — the link alone is not proof, as with invites.
 *
 * Files it straight away when the address matches a property already in that
 * team; otherwise it arrives unfiled and the app asks which property, or offers
 * to create it from the report's address.
 */
create or replace function public.claim_report(p_token uuid, p_team_id uuid)
returns public.report_deliveries language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_row   public.report_deliveries;
  v_type  text;
  v_loc   uuid;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;

  select * into v_row from public.report_deliveries where token = p_token for update;
  if v_row.id is null then raise exception 'That report link is not valid'; end if;
  -- No address matches nothing (see accept_invite), and the refusal does not
  -- name the address it went to, which report_preview() never reveals either.
  if v_email is null or lower(v_row.recipient_email) <> v_email then
    raise exception 'That report was sent to someone else, not to you';
  end if;

  if v_row.recipient_team_id is not null then
    if public.is_team_member(v_row.recipient_team_id) then return v_row; end if;
    raise exception 'That report has already been saved to another account';
  end if;

  if not public.is_team_member(p_team_id) then raise exception 'You are not in that team'; end if;
  select account_type into v_type from public.teams where id = p_team_id;
  if v_type not in ('landlord', 'agency') then
    raise exception 'Reports are saved to a landlord or agency account';
  end if;

  select l.id into v_loc
    from public.locations l
   where l.team_id = p_team_id
     and lower(btrim(l.address)) = lower(btrim(coalesce(v_row.site ->> 'address', '')))
     and lower(btrim(l.suburb))  = lower(btrim(coalesce(v_row.site ->> 'suburb', '')))
   limit 1;

  return public._file_delivery(v_row.id, p_team_id, v_loc, v_uid);
end;
$$;

/**
 * File (or re-file) a claimed report under one of the recipient team's
 * properties.
 */
create or replace function public.file_report(p_delivery_id uuid, p_location_id uuid)
returns public.report_deliveries language plpgsql security definer set search_path = public as $$
declare
  v_row      public.report_deliveries;
  v_loc_team uuid;
begin
  select * into v_row from public.report_deliveries where id = p_delivery_id for update;
  if v_row.id is null or v_row.recipient_team_id is null
     or not public.is_team_member(v_row.recipient_team_id) then
    raise exception 'That report is not in your account';
  end if;

  select team_id into v_loc_team from public.locations where id = p_location_id;
  if v_loc_team is distinct from v_row.recipient_team_id then
    raise exception 'That property is not in this account';
  end if;

  return public._file_delivery(v_row.id, v_row.recipient_team_id, p_location_id, auth.uid());
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The Due page and reminder opt-outs
-- ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything a team needs to act on soon, in one list. Members only: SECURITY
 * INVOKER, so RLS hands a non-member nothing.
 *
 *   overdue      — a check whose due date has passed
 *   due          — a check due within p_within_days
 *   not_done_yet — a site on a regular interval the team set (workflow_intervals)
 *                  that has never had that check, so it has no due date (D7)
 *   expiring     — equipment, chiefly smoke alarms, whose expires_on falls
 *                  within p_expiry_months (or has passed) and is still in place
 *
 * For 'expiring' rows, obligation is the asset type and label the asset's own.
 * Every row carries its client and site, for the page and the reminder email.
 */
create or replace function public.due_list(
  p_team_id       uuid,
  p_within_days   int default 60,
  p_expiry_months int default 3
)
returns table (
  kind              text,
  due_on            date,
  item_id           uuid,
  asset_id          uuid,
  obligation        text,
  label             text,
  last_done_on      date,
  reminders_enabled boolean,
  client_id         uuid,
  client_name       text,
  contact_name      text,
  contact_email     text,
  location_id       uuid,
  address           text,
  suburb            text
)
language sql stable set search_path = public as $$
  with today as (select public.local_day(now()) as d)
  select r.* from (
    select case when ci.next_due_on < t.d then 'overdue' else 'due' end as kind,
           ci.next_due_on      as due_on,
           ci.id               as item_id,
           null::uuid          as asset_id,
           ci.obligation       as obligation,
           ci.label            as label,
           ci.last_done_on     as last_done_on,
           ci.reminders_enabled as reminders_enabled,
           c.id                as client_id,
           c.name              as client_name,
           c.contact_name      as contact_name,
           c.contact_email     as contact_email,
           l.id                as location_id,
           l.address           as address,
           l.suburb            as suburb
      from public.compliance_items ci
      join public.locations l on l.id = ci.location_id
      join public.clients   c on c.id = l.client_id
      cross join today t
     where ci.team_id = p_team_id
       and ci.active
       and ci.next_due_on is not null
       and ci.next_due_on <= t.d + p_within_days

    union all

    -- An item switched off (active = false) stays off: the team said this
    -- site no longer needs it.
    select 'not_done_yet', null::date, ci.id, null::uuid, w.id, w.label, null::date,
           coalesce(ci.reminders_enabled, true), c.id, c.name, c.contact_name, c.contact_email,
           l.id, l.address, l.suburb
      from public.locations l
      join public.clients   c on c.id = l.client_id
      join public.workflows w
        on w.id in (select wi.workflow_id from public.workflow_intervals wi where wi.team_id = p_team_id)
      left join public.compliance_items ci on ci.location_id = l.id and ci.obligation = w.id
     where l.team_id = p_team_id
       and not w.interval_fixed
       and public.team_interval(p_team_id, w.id, l.client_id) is not null
       and (ci.id is null or (ci.active and ci.next_due_on is null))

    union all

    select 'expiring', a.expires_on, null::uuid, a.id, a.asset_type, a.label, null::date,
           null::boolean, c.id, c.name, c.contact_name, c.contact_email,
           l.id, l.address, l.suburb
      from public.assets a
      join public.locations l on l.id = a.location_id
      join public.clients   c on c.id = l.client_id
      cross join today t
     where a.team_id = p_team_id
       and a.removed_at is null
       and a.expires_on is not null
       and a.expires_on <= (t.d + make_interval(months => p_expiry_months))::date
  ) r
  order by r.due_on nulls last, r.address, r.label;
$$;

/**
 * A reminder email's "No longer needed" link. Callable without signing in: the
 * token is the credential, as with a report link.
 *
 * Switches that one check's reminders off and tells the provider's owners and
 * admins, once, with a 'reminder_opt_out' notice ("Jane says the check at 10
 * Smith St is no longer needed"). Returns only what the confirmation page
 * says — the provider's business name and the site's address — and no rows for
 * a token that does not exist.
 */
create or replace function public.reminder_opt_out(p_token uuid)
returns table (provider text, address text, suburb text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_item     public.compliance_items;
  v_loc      public.locations;
  v_client   public.clients;
  v_provider text;
begin
  select * into v_item from public.compliance_items ci where ci.reminder_token = p_token for update;
  if v_item.id is null then return; end if;

  select * into v_loc    from public.locations l
   where l.id = v_item.location_id and l.team_id = v_item.team_id;
  select * into v_client from public.clients   c
   where c.id = v_loc.client_id and c.team_id = v_item.team_id;
  select coalesce(nullif(btrim(s.company ->> 'name'), ''), t.name) into v_provider
    from public.teams t
    left join public.team_settings s on s.team_id = t.id
   where t.id = v_item.team_id;

  -- Every click works: reminders a member switched back on go off again, and
  -- the provider is told each time. A click on reminders already off changes
  -- nothing and tells nobody twice.
  if v_item.reminders_enabled or v_item.opted_out_at is null then
    update public.compliance_items ci
       set reminders_enabled = false, opted_out_at = now(), opted_out_via = 'email_link'
     where ci.id = v_item.id;

    insert into public.team_notices (team_id, kind, payload)
      values (v_item.team_id, 'reminder_opt_out', jsonb_build_object(
        'compliance_item_id', v_item.id,
        'location_id',        v_loc.id,
        'label',              v_item.label,
        'address',            v_loc.address,
        'suburb',             v_loc.suburb,
        'contact_name',       v_client.contact_name,
        'contact_email',      v_client.contact_email));
  end if;

  return query select v_provider, v_loc.address, v_loc.suburb;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Storage: two private buckets, one folder per team
-- ─────────────────────────────────────────────────────────────────────────────
--
--   evidence/<team_id>/…  photos and hand-uploaded certificates. The team only.
--   reports/<team_id>/…   delivered report files. The sending team, and whoever
--                         a delivery naming that exact file has been saved to.
--
-- No UPDATE or DELETE policy on reports: a delivered report cannot be swapped
-- or withdrawn from under the person it was sent to. Anonymous viewers of a
-- link get the file through a short-lived signed URL made by the Edge Function
-- after report_preview() has accepted the token.
--
-- If this section is refused with "must be owner of table objects", create the
-- two buckets in Dashboard → Storage instead and run just the policies.

insert into storage.buckets (id, name, public) values
  ('evidence', 'evidence', false),
  ('reports',  'reports',  false)
on conflict (id) do nothing;

-- The team a stored object belongs to: its first folder, if that is a uuid.
-- Anything else is nobody's, so every policy below fails closed on it.
create or replace function public.path_team(p_name text)
returns uuid language sql immutable set search_path = public as $$
  select case
    when split_part(coalesce(p_name, ''), '/', 1)
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then split_part(p_name, '/', 1)::uuid
  end;
$$;

drop policy if exists pemcora_evidence_select on storage.objects;
create policy pemcora_evidence_select on storage.objects
  for select to authenticated
  using (bucket_id = 'evidence' and public.is_team_member(public.path_team(name)));

-- Whether the caller may add photos to a team's folder: a member, and Pro once
-- limits are on. Unlike team_is_pro() it answers only for the caller's own
-- teams, so the policy can call it as the signed-in user.
create or replace function public.can_add_evidence(_team_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.is_team_member(_team_id)
     and (not public.limits_enforced() or public.team_is_pro(_team_id));
$$;
revoke execute on function public.can_add_evidence(uuid) from public, anon;
grant  execute on function public.can_add_evidence(uuid) to authenticated;

drop policy if exists pemcora_evidence_insert on storage.objects;
create policy pemcora_evidence_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'evidence' and public.can_add_evidence(public.path_team(name)));

drop policy if exists pemcora_evidence_delete on storage.objects;
create policy pemcora_evidence_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'evidence' and public.is_team_member(public.path_team(name)));

-- Nothing in reports/ can ever be deleted, so it takes what step D2 puts
-- there and nothing else: <team_id>/<name>.pdf.
drop policy if exists pemcora_reports_insert on storage.objects;
create policy pemcora_reports_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'reports'
    and public.is_team_member(public.path_team(name))
    and name ~* '^[^/]+/[^/]+\.pdf$'
  );

-- And Storage itself refuses anything else, or anything large, on Supabase.
-- The test stub's storage.buckets has neither column, hence the test.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'allowed_mime_types') then
    update storage.buckets
       set allowed_mime_types = array['application/pdf'], file_size_limit = 10485760
     where id = 'reports';
  end if;
end $$;

drop policy if exists pemcora_reports_select on storage.objects;
create policy pemcora_reports_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reports'
    and (
      public.is_team_member(public.path_team(name))
      or exists (
        select 1 from public.report_deliveries d
         where d.file_path = objects.name
           and public.is_team_member(d.recipient_team_id)
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security and privileges
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.assets            enable row level security;
alter table public.compliance_items  enable row level security;
alter table public.attachments       enable row level security;
alter table public.report_deliveries enable row level security;
alter table public.site_links        enable row level security;
alter table public.workflow_intervals enable row level security;

-- 0001's field data gets the same parent check as the tables below. Its
-- policies only ask whether the caller is in the row's own team, so a member
-- could hang a visit off another team's site or a site off another team's
-- client — and send_report(), reminder_opt_out() and set_workflow_interval()
-- read through those parents as their owner. Report recipients see provider
-- site and visit ids, so the ids are not secret enough to rely on.
drop policy if exists locations_all on public.locations;
create policy locations_all on public.locations
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and exists (select 1 from public.clients c
                 where c.id = locations.client_id and c.team_id = locations.team_id)
  );

drop policy if exists floors_all on public.floors;
create policy floors_all on public.floors
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and exists (select 1 from public.locations l
                 where l.id = floors.location_id and l.team_id = floors.team_id)
  );

drop policy if exists rooms_all on public.rooms;
create policy rooms_all on public.rooms
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and exists (select 1 from public.floors f
                 where f.id = rooms.floor_id and f.team_id = rooms.team_id)
  );

drop policy if exists visits_all on public.visits;
create policy visits_all on public.visits
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and exists (select 1 from public.locations l
                 where l.id = visits.location_id and l.team_id = visits.team_id)
  );

drop policy if exists visit_rooms_all on public.visit_rooms;
create policy visit_rooms_all on public.visit_rooms
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and exists (select 1 from public.visits v
                 where v.id = visit_rooms.visit_id and v.team_id = visit_rooms.team_id)
    and (visit_rooms.room_id is null
         or exists (select 1 from public.rooms r
                     where r.id = visit_rooms.room_id and r.team_id = visit_rooms.team_id))
  );

drop policy if exists visit_exports_all on public.visit_exports;
create policy visit_exports_all on public.visit_exports
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and exists (select 1 from public.visits v
                 where v.id = visit_exports.visit_id and v.team_id = visit_exports.team_id)
  );

-- Field data: any member, full CRUD, as in 0001 — plus a check 0001 does not
-- make: the parent row has to be in the same team. Without it a member could
-- hang their own rows off another team's location id.
drop policy if exists assets_all on public.assets;
create policy assets_all on public.assets
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and exists (select 1 from public.locations l
                 where l.id = assets.location_id and l.team_id = assets.team_id)
    and (assets.room_id is null
         or exists (select 1 from public.rooms r
                     where r.id = assets.room_id and r.team_id = assets.team_id))
  );

drop policy if exists compliance_items_all on public.compliance_items;
create policy compliance_items_all on public.compliance_items
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and exists (select 1 from public.locations l
                 where l.id = compliance_items.location_id and l.team_id = compliance_items.team_id)
    and (compliance_items.last_visit_id is null
         or exists (select 1 from public.visits v
                     where v.id = compliance_items.last_visit_id and v.team_id = compliance_items.team_id))
    and (compliance_items.evidence_path is null
         or public.path_team(compliance_items.evidence_path) = compliance_items.team_id)
  );

drop policy if exists attachments_all on public.attachments;
create policy attachments_all on public.attachments
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and public.path_team(attachments.storage_path) = attachments.team_id
    and (attachments.visit_id is null
         or exists (select 1 from public.visits v
                     where v.id = attachments.visit_id and v.team_id = attachments.team_id))
    and (attachments.visit_room_id is null
         or exists (select 1 from public.visit_rooms vr
                     where vr.id = attachments.visit_room_id and vr.team_id = attachments.team_id))
    and (attachments.asset_id is null
         or exists (select 1 from public.assets a
                     where a.id = attachments.asset_id and a.team_id = attachments.team_id))
  );

-- Deliveries: both ends read; nobody writes except through the functions above.
drop policy if exists report_deliveries_select on public.report_deliveries;
create policy report_deliveries_select on public.report_deliveries
  for select to authenticated
  using (public.is_team_member(provider_team_id) or public.is_team_member(recipient_team_id));

drop policy if exists site_links_select on public.site_links;
create policy site_links_select on public.site_links
  for select to authenticated
  using (public.is_team_member(provider_team_id) or public.is_team_member(recipient_team_id));

drop policy if exists site_links_delete on public.site_links;
create policy site_links_delete on public.site_links
  for delete to authenticated
  using (public.is_team_member(recipient_team_id));

-- Intervals: every member reads them (the Due page, the client page); only
-- set_workflow_interval() writes, so there is no write policy at all.
drop policy if exists workflow_intervals_select on public.workflow_intervals;
create policy workflow_intervals_select on public.workflow_intervals
  for select to authenticated
  using (public.is_team_member(team_id));

revoke all on table
  public.assets, public.compliance_items, public.attachments,
  public.report_deliveries, public.site_links, public.workflow_intervals
from anon, authenticated;

grant select, insert, update, delete on table
  public.assets, public.attachments
to authenticated;
grant select         on table public.report_deliveries  to authenticated;
grant select, delete on table public.site_links         to authenticated;
grant select         on table public.workflow_intervals to authenticated;

-- Compliance items: members keep their team's checks — the dates, the
-- interval, the evidence, the reminder switch, whether the check still
-- applies — but not the reminder bookkeeping. The token in the emailed link,
-- when and how a client opted out, when the last reminder went and which visit
-- or report last did the check are written by the functions above and the
-- reminder job, so a client opt-out cannot be erased or a reminder re-sent.
grant select, insert, delete on table public.compliance_items to authenticated;
grant update (label, interval_months, last_done_on, next_due_on, evidence_path,
              remind_days_before, reminders_enabled, active)
  on table public.compliance_items to authenticated;

revoke execute on function public.advance_compliance()                 from public, anon, authenticated;
revoke execute on function public.compliance_next_due()                from public, anon, authenticated;
revoke execute on function public.keep_opt_out()                       from public, anon, authenticated;
revoke execute on function public.stamp_signoff()                      from public, anon, authenticated;
revoke execute on function public.pack_in_use(uuid, text)              from public, anon, authenticated;
revoke execute on function public.gate_attachment()                    from public, anon, authenticated;
revoke execute on function public._file_delivery(uuid, uuid, uuid, uuid) from public, anon, authenticated;

revoke execute on function public.path_team(text)                              from public, anon;
revoke execute on function public.send_report(uuid, text, jsonb, text)         from public, anon;
revoke execute on function public.revoke_report(uuid)                          from public, anon;
revoke execute on function public.resend_report(uuid)                          from public, anon;
revoke execute on function public.claim_report(uuid, uuid)                     from public, anon;
revoke execute on function public.file_report(uuid, uuid)                      from public, anon;
revoke execute on function public.team_interval(uuid, text, uuid)              from public, anon;
revoke execute on function public.effective_interval(uuid, text, uuid)         from public, anon;
revoke execute on function public.set_workflow_interval(uuid, text, uuid, int) from public, anon;
revoke execute on function public.due_list(uuid, int, int)                     from public, anon;
grant  execute on function public.path_team(text)                              to authenticated;
grant  execute on function public.send_report(uuid, text, jsonb, text)         to authenticated;
grant  execute on function public.revoke_report(uuid)                          to authenticated;
grant  execute on function public.resend_report(uuid)                          to authenticated;
grant  execute on function public.claim_report(uuid, uuid)                     to authenticated;
grant  execute on function public.file_report(uuid, uuid)                      to authenticated;
grant  execute on function public.team_interval(uuid, text, uuid)              to authenticated;
grant  execute on function public.effective_interval(uuid, text, uuid)         to authenticated;
grant  execute on function public.set_workflow_interval(uuid, text, uuid, int) to authenticated;
grant  execute on function public.due_list(uuid, int, int)                     to authenticated;
-- anon too: a report link and a reminder's opt-out link both have to work
-- before there is an account.
revoke execute on function public.report_preview(uuid)                     from public;
grant  execute on function public.report_preview(uuid)                     to anon, authenticated;
revoke execute on function public.reminder_opt_out(uuid)                   from public;
grant  execute on function public.reminder_opt_out(uuid)                   to anon, authenticated;

-- PostgREST caches the schema; without this the new tables and functions 404
-- until the next restart.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — every number below should be 1 except tables (6), buckets (2),
-- storage_policies (5), and file_delivery_exposed, interval_writes_exposed and
-- opt_out_writable, which must be 0.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select count(*) from pg_tables
    where schemaname = 'public'
      and tablename in ('assets', 'compliance_items', 'attachments',
                        'report_deliveries', 'site_links', 'workflow_intervals')) as tables,
  (select count(*) from pg_trigger
    where tgname = 'visits_stamp_signoff' and not tgisinternal)            as trg_stamp_signoff,
  (select count(*) from pg_trigger
    where tgname = 'compliance_items_keep_opt_out' and not tgisinternal)   as trg_keep_opt_out,
  (select count(*) from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'compliance_items'
      and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE'
      and column_name in ('reminder_token', 'opted_out_at', 'opted_out_via',
                          'last_reminded_at', 'last_visit_id', 'last_delivery_id')) as opt_out_writable,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'workflow_intervals'
      and c.relrowsecurity)                                                as intervals_rls_on,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'workflow_intervals'
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))               as interval_writes_exposed,
  (select count(*) from pg_trigger
    where tgname = 'compliance_items_next_due' and not tgisinternal)       as trg_next_due,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'report_deliveries'
      and column_name = 'link_expires_at')                                 as col_link_expiry,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'visits'
      and column_name = 'signoff')                                         as col_signoff,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reminder_opt_out')          as fn_opt_out,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'report_deliveries'
      and c.relrowsecurity)                                                as deliveries_rls_on,
  (select count(*) from pg_trigger
    where tgname = 'visits_advance_compliance' and not tgisinternal)       as trg_advance,
  (select count(*) from pg_trigger
    where tgname = 'attachments_gate' and not tgisinternal)                as trg_photo_gate,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'visits'
      and column_name = 'site_results')                                    as col_site_results,
  (select count(*) from storage.buckets where id in ('evidence', 'reports')) as buckets,
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'pemcora\_%')                                    as storage_policies,
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = '_file_delivery'
      and grantee in ('anon', 'authenticated', 'PUBLIC'))                  as file_delivery_exposed;

-- Rows whose parent is in another team. Must be 0; any that turn up were
-- written before the parent checks and need looking at by hand.
select
  (select count(*) from public.locations x join public.clients   p on p.id = x.client_id   where p.team_id <> x.team_id)
+ (select count(*) from public.floors    x join public.locations p on p.id = x.location_id where p.team_id <> x.team_id)
+ (select count(*) from public.rooms     x join public.floors    p on p.id = x.floor_id    where p.team_id <> x.team_id)
+ (select count(*) from public.visits    x join public.locations p on p.id = x.location_id where p.team_id <> x.team_id)
+ (select count(*) from public.visit_rooms   x join public.visits p on p.id = x.visit_id   where p.team_id <> x.team_id)
+ (select count(*) from public.visit_exports x join public.visits p on p.id = x.visit_id   where p.team_id <> x.team_id)
    as cross_team_rows;
