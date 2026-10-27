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

-- Who to send the report and the re-check reminder to.
alter table public.clients
  add column if not exists contact_name  text not null default '',
  add column if not exists contact_email text not null default '',
  add column if not exists contact_phone text not null default '';

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
alter table public.visits
  add column if not exists site_results jsonb not null default '{}'::jsonb,
  add column if not exists outcome      text;

-- Measured values beside the PASS/FAIL verdicts: insulation resistance, RCD
-- trip times, earth continuity. Keyed like results — { sectionId: { testId:
-- { value, unit } } } — so a verdict and its reading always line up.
alter table public.visit_rooms
  add column if not exists readings jsonb not null default '{}'::jsonb;

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
end $$;

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
--               adds the provider's own name and company details over the top,
--               so a report always says truthfully which team it came from.
--   token     — the credential in the emailed link, as with team_invites.

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
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (location_id, obligation)
);
create index if not exists compliance_items_team_idx on public.compliance_items(team_id);
create index if not exists compliance_items_due_idx  on public.compliance_items(team_id, next_due_on) where active;

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
  foreach t in array array['assets', 'compliance_items'] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A completed visit moves its site's due dates on
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The first time a recurring workflow (one with default_interval_months) is
-- completed at a site, that site gets its compliance item; every completion
-- after moves next_due_on forward. Nobody has to set up a schedule for the
-- re-check list to exist.
--
-- AFTER INSERT as well as UPDATE, so visits imported already completed build
-- the schedule too. Never backwards: completing an older visit late does not
-- pull a newer due date back. Reopening a visit does not undo anything.
--
-- SECURITY INVOKER on purpose. The person completing the visit can already
-- write their own team's items, and RLS keeps this to their own team's rows.

create or replace function public.advance_compliance()
returns trigger language plpgsql set search_path = public as $$
declare
  v_done     date;
  v_interval int;
  v_label    text;
begin
  if new.completed_at is null then return new; end if;
  -- Nested, not `tg_op = 'UPDATE' and old.completed_at ...` — see 0005.
  if tg_op = 'UPDATE' then
    if old.completed_at is not null then return new; end if;
  end if;

  v_done := public.local_day(new.completed_at);

  select w.default_interval_months, w.label into v_interval, v_label
    from public.workflows w where w.id = new.kind;

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
     and c.satisfied_by = new.kind
     and c.active
     and (c.last_done_on is null or c.last_done_on <= v_done);

  return new;
end;
$$;

drop trigger if exists visits_advance_compliance on public.visits;
create trigger visits_advance_compliance after insert or update of completed_at on public.visits
  for each row execute function public.advance_compliance();

-- Photos are a Pro feature. Checked on the row as well as on the upload (see
-- the storage policies), so neither can be had without the other. Like every
-- limit in 0006, only once app_settings.enforce_limits is on.
create or replace function public.gate_attachment()
returns trigger language plpgsql set search_path = public as $$
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

  select * into v_loc  from public.locations where id = v_visit.location_id;
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
    coalesce(p_snapshot, '{}'::jsonb) || jsonb_build_object(
      'provider', jsonb_build_object(
        'team_id', v_team.id, 'name', v_team.name, 'company', coalesce(v_co, '{}'::jsonb))),
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

/**
 * What a report link shows, to anyone holding it — signed in or not. The link
 * is the credential, as an emailed PDF would be. Marks the report opened.
 *
 * Never returns the recipient's address or any provider-side id.
 */
create or replace function public.report_preview(p_token uuid)
returns table (
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
  update public.report_deliveries
     set opened_at = coalesce(opened_at, now())
   where token = p_token;

  return query
    select w.label, d.snapshot #>> '{provider,name}', d.completed_on, d.outcome,
           d.site, d.snapshot #- '{provider,team_id}',
           d.file_path is not null, d.recipient_team_id is not null
      from public.report_deliveries d
      join public.workflows w on w.id = d.workflow_id
     where d.token = p_token;
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
  if lower(v_row.recipient_email) <> v_email then
    raise exception 'That report was sent to %, not to you', v_row.recipient_email;
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

drop policy if exists pemcora_evidence_insert on storage.objects;
create policy pemcora_evidence_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and public.is_team_member(public.path_team(name))
    and (not public.limits_enforced() or public.team_is_pro(public.path_team(name)))
  );

drop policy if exists pemcora_evidence_delete on storage.objects;
create policy pemcora_evidence_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'evidence' and public.is_team_member(public.path_team(name)));

drop policy if exists pemcora_reports_insert on storage.objects;
create policy pemcora_reports_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'reports' and public.is_team_member(public.path_team(name)));

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

revoke all on table
  public.assets, public.compliance_items, public.attachments,
  public.report_deliveries, public.site_links
from anon, authenticated;

grant select, insert, update, delete on table
  public.assets, public.compliance_items, public.attachments
to authenticated;
grant select         on table public.report_deliveries to authenticated;
grant select, delete on table public.site_links        to authenticated;

revoke execute on function public.advance_compliance()                 from public, anon, authenticated;
revoke execute on function public.gate_attachment()                    from public, anon, authenticated;
revoke execute on function public._file_delivery(uuid, uuid, uuid, uuid) from public, anon, authenticated;

revoke execute on function public.path_team(text)                          from public, anon;
revoke execute on function public.send_report(uuid, text, jsonb, text)     from public, anon;
revoke execute on function public.revoke_report(uuid)                      from public, anon;
revoke execute on function public.claim_report(uuid, uuid)                 from public, anon;
revoke execute on function public.file_report(uuid, uuid)                  from public, anon;
grant  execute on function public.path_team(text)                          to authenticated;
grant  execute on function public.send_report(uuid, text, jsonb, text)     to authenticated;
grant  execute on function public.revoke_report(uuid)                      to authenticated;
grant  execute on function public.claim_report(uuid, uuid)                 to authenticated;
grant  execute on function public.file_report(uuid, uuid)                  to authenticated;
-- anon too: the link has to open before there is an account.
revoke execute on function public.report_preview(uuid)                     from public;
grant  execute on function public.report_preview(uuid)                     to anon, authenticated;

-- PostgREST caches the schema; without this the new tables and functions 404
-- until the next restart.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — every number below should be 1 except tables (5), buckets (2),
-- storage_policies (5), and file_delivery_exposed, which must be 0.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select count(*) from pg_tables
    where schemaname = 'public'
      and tablename in ('assets', 'compliance_items', 'attachments',
                        'report_deliveries', 'site_links'))                 as tables,
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
