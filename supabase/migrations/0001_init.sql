-- Pemcora — schema, RLS and team RPCs.
-- Run in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- Safe to re-run: IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS throughout.
--
-- Roles are owner > admin > member. This is the one place Pemcora deliberately
-- departs from PM v2, which had only admin|member and let any admin promote
-- anyone. Here:
--   owner  — exactly one per team, the person who created it. Only the owner
--            grants or revokes admin. Cannot be demoted, removed, or leave;
--            ownership moves only via transfer_ownership.
--   admin  — manages the shared test lists, company branding, and members,
--            but can only remove plain members and can never mint an admin.
--   member — full CRUD on the field data (clients, visits, results).
--
-- Role changes are NOT possible through the table: there is no UPDATE policy on
-- team_members at all. They go through set_member_role, which is SECURITY
-- DEFINER and checks ownership. Without that, a member could PATCH their own
-- row to role='owner', because RLS cannot restrict which columns an UPDATE
-- touches.

-- ─────────────────────────────────────────────────────────────────────────────
-- Teams and membership
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.team_members (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);
create index if not exists team_members_user_idx on public.team_members(user_id);

-- Exactly one owner per team, enforced by the database rather than by trusting
-- every code path that writes a role.
create unique index if not exists team_members_one_owner_idx
  on public.team_members(team_id) where role = 'owner';

-- Per-member preferences. Separate from team_members precisely so a user can be
-- allowed to write their own row without that also being a route to editing
-- their own role.
create table if not exists public.member_prefs (
  team_id            uuid not null references public.teams(id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  default_technician text not null default '',
  primary key (team_id, user_id)
);

-- Shared branding and company details. Printed on every report, so it is
-- team-wide and admin-only. Logos are data URIs, capped at 200 KB by the app.
create table if not exists public.team_settings (
  team_id        uuid primary key references public.teams(id) on delete cascade,
  company        jsonb not null default '{}'::jsonb,
  logo_full      jsonb,
  logo_collapsed jsonb,
  plate          text  not null default 'brass',
  updated_at     timestamptz not null default now()
);

-- One row per workflow. The default lists are NOT seeded here on purpose:
-- src/data/testLists.js is the single source of truth and the app writes them
-- on first load. Duplicating ~60 test labels into SQL guarantees the two drift
-- the first time a list is edited.
create table if not exists public.team_templates (
  team_id    uuid not null references public.teams(id) on delete cascade,
  kind       text not null check (kind in ('maintenance', 'commissioning', 'custom')),
  template   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (team_id, kind)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Field data: clients → locations → floors → rooms
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references public.teams(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clients_team_idx on public.clients(team_id);

-- The app already refuses duplicate client names; this makes it true even if two
-- technicians add the same client at the same moment on different devices.
create unique index if not exists clients_team_name_idx
  on public.clients(team_id, lower(btrim(name)));

create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  team_id    uuid not null references public.teams(id) on delete cascade,
  address    text not null default '',
  suburb     text not null default '',
  city       text not null default '',
  state      text not null default '',
  postcode   text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists locations_client_idx on public.locations(client_id);
create index if not exists locations_team_idx on public.locations(team_id);

-- Matches the app's rule: a location is identified by address + suburb within a
-- client, case- and whitespace-insensitive.
create unique index if not exists locations_client_addr_idx
  on public.locations(client_id, lower(btrim(address)), lower(btrim(suburb)));

create table if not exists public.floors (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  team_id     uuid not null references public.teams(id) on delete cascade,
  label       text not null default '',
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists floors_location_idx on public.floors(location_id);
create index if not exists floors_team_idx on public.floors(team_id);

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  floor_id    uuid not null references public.floors(id) on delete cascade,
  team_id     uuid not null references public.teams(id) on delete cascade,
  name        text not null default '',
  plan_number text not null default '',
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists rooms_floor_idx on public.rooms(floor_id);
create index if not exists rooms_team_idx on public.rooms(team_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Visits and their per-room results
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.visits (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations(id) on delete cascade,
  team_id      uuid not null references public.teams(id) on delete cascade,
  kind         text not null check (kind in ('maintenance', 'commissioning', 'custom')),
  technician   text not null default '',
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now()
);
create index if not exists visits_location_idx on public.visits(location_id);
create index if not exists visits_team_idx on public.visits(team_id);

-- "Only one open visit per location per kind" — the rule the app enforces, made
-- true at the database so two devices cannot both open one.
create unique index if not exists visits_one_open_per_kind_idx
  on public.visits(location_id, kind) where completed_at is null;

create table if not exists public.visit_rooms (
  id               uuid primary key default gen_random_uuid(),
  visit_id         uuid not null references public.visits(id) on delete cascade,
  team_id          uuid not null references public.teams(id) on delete cascade,

  -- Nullable, and the identifying detail is copied alongside it. A room deleted
  -- from a floor plan must not blank out a report that was already signed off.
  room_id          uuid references public.rooms(id) on delete set null,
  room_name        text not null default '',
  plan_number      text not null default '',
  floor_label      text not null default '',
  position         int  not null default 0,

  results          jsonb not null default '{}'::jsonb,   -- { main: {testId: PASS|FAIL|NA}, [sectionId]: {...} }
  troubleshooting  jsonb not null default '{}'::jsonb,   -- { testId: note }
  sections_enabled jsonb not null default '{}'::jsonb,   -- { sectionId: bool }
  comments         text  not null default '',
  status           text  not null default 'in_progress' check (status in ('in_progress', 'complete')),
  fails            int   not null default 0,

  -- The template this room was filled in against. Never read live: editing a
  -- list in Settings must not rewrite work already signed off.
  template         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (visit_id, room_id)
);
create index if not exists visit_rooms_visit_idx on public.visit_rooms(visit_id);
create index if not exists visit_rooms_team_idx on public.visit_rooms(team_id);

-- Only the revision record is kept; any revision regenerates from the visit.
create table if not exists public.visit_exports (
  id          uuid primary key default gen_random_uuid(),
  visit_id    uuid not null references public.visits(id) on delete cascade,
  team_id     uuid not null references public.teams(id) on delete cascade,
  revision    int  not null,
  exported_at timestamptz not null default now(),
  exported_by uuid references auth.users(id) on delete set null,
  unique (visit_id, revision)
);
create index if not exists visit_exports_visit_idx on public.visit_exports(visit_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers. SECURITY DEFINER so they bypass RLS — otherwise checking
-- team_members from inside team_members' own policy recurses.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.is_team_member(_team_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where team_id = _team_id and user_id = auth.uid()
  );
$$;

-- The owner is an admin for every purpose except granting admin.
create or replace function public.is_team_admin(_team_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where team_id = _team_id and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

create or replace function public.is_team_owner(_team_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where team_id = _team_id and user_id = auth.uid() and role = 'owner'
  );
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'team_settings', 'team_templates', 'clients', 'locations',
    'visits', 'visit_rooms'
  ] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Team RPCs
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_team(p_name text)
returns public.teams language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_code text;
  v_team public.teams;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (select 1 from public.teams where invite_code = v_code);
  end loop;

  insert into public.teams (name, invite_code)
    values (coalesce(nullif(trim(p_name), ''), 'My Team'), v_code)
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

create or replace function public.join_team(p_invite_code text)
returns public.teams language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_team public.teams;
begin
  if v_uid is null then raise exception 'Not authenticated'; end if;

  select * into v_team from public.teams where invite_code = upper(trim(p_invite_code));
  if v_team.id is null then raise exception 'Invalid invite code'; end if;

  -- Always 'member'. Promotion is the owner's call alone.
  insert into public.team_members (team_id, user_id, role)
    values (v_team.id, v_uid, 'member')
    on conflict (team_id, user_id) do nothing;
  insert into public.member_prefs (team_id, user_id)
    values (v_team.id, v_uid)
    on conflict (team_id, user_id) do nothing;

  return v_team;
end;
$$;

create or replace function public.my_teams()
returns table (team_id uuid, name text, invite_code text, role text)
language sql security definer set search_path = public as $$
  select t.id, t.name, t.invite_code, m.role
  from public.team_members m
  join public.teams t on t.id = m.team_id
  where m.user_id = auth.uid();
$$;

-- auth.users is not client-readable, so a definer function exposes just the
-- email, and only to members of that team.
create or replace function public.team_members_list(p_team_id uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.team_members m
  join auth.users u on u.id = m.user_id
  where m.team_id = p_team_id
    and public.is_team_member(p_team_id)
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at;
$$;

-- The only way a role ever changes. Owner-only, and it refuses to create a
-- second owner or to strip the existing one.
create or replace function public.set_member_role(p_team_id uuid, p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_team_owner(p_team_id) then
    raise exception 'Only the team owner can change roles';
  end if;
  if p_role not in ('admin', 'member') then
    raise exception 'Role must be admin or member. Use transfer_ownership to move ownership.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'The owner cannot change their own role';
  end if;
  if exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = p_user_id and role = 'owner'
  ) then
    raise exception 'The owner cannot be demoted';
  end if;

  update public.team_members
    set role = p_role
    where team_id = p_team_id and user_id = p_user_id;

  if not found then raise exception 'That person is not in this team'; end if;
end;
$$;

-- So the account is not a single point of failure. Owner-only; the outgoing
-- owner becomes an admin.
create or replace function public.transfer_ownership(p_team_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.is_team_owner(p_team_id) then
    raise exception 'Only the team owner can transfer ownership';
  end if;
  if p_user_id = v_uid then raise exception 'You already own this team'; end if;
  if not exists (
    select 1 from public.team_members where team_id = p_team_id and user_id = p_user_id
  ) then
    raise exception 'That person is not in this team';
  end if;

  -- Step down first: the one-owner index would reject the other order.
  update public.team_members set role = 'admin'
    where team_id = p_team_id and user_id = v_uid;
  update public.team_members set role = 'owner'
    where team_id = p_team_id and user_id = p_user_id;
end;
$$;

grant execute on function public.create_team(text)                     to authenticated;
grant execute on function public.join_team(text)                       to authenticated;
grant execute on function public.my_teams()                            to authenticated;
grant execute on function public.team_members_list(uuid)               to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text)     to authenticated;
grant execute on function public.transfer_ownership(uuid, uuid)        to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.teams          enable row level security;
alter table public.team_members   enable row level security;
alter table public.member_prefs   enable row level security;
alter table public.team_settings  enable row level security;
alter table public.team_templates enable row level security;
alter table public.clients        enable row level security;
alter table public.locations      enable row level security;
alter table public.floors         enable row level security;
alter table public.rooms          enable row level security;
alter table public.visits         enable row level security;
alter table public.visit_rooms    enable row level security;
alter table public.visit_exports  enable row level security;

-- teams: members read; admins rename. Deletion is owner-only — losing every
-- client and visit should not be one mis-click by a promoted colleague.
drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams
  for select to authenticated using (public.is_team_member(id));
drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams
  for update to authenticated using (public.is_team_admin(id)) with check (public.is_team_admin(id));
drop policy if exists teams_delete on public.teams;
create policy teams_delete on public.teams
  for delete to authenticated using (public.is_team_owner(id));

-- team_members: readable by the team. Deliberately NO update policy — roles move
-- only through set_member_role / transfer_ownership.
drop policy if exists team_members_select on public.team_members;
create policy team_members_select on public.team_members
  for select to authenticated using (public.is_team_member(team_id));
drop policy if exists team_members_update on public.team_members;
drop policy if exists team_members_delete on public.team_members;
create policy team_members_delete on public.team_members
  for delete to authenticated using (
    -- leave the team yourself, unless you own it
    (user_id = auth.uid() and role <> 'owner')
    -- the owner removes anyone but themselves
    or (public.is_team_owner(team_id) and user_id <> auth.uid())
    -- an admin removes plain members only, never another admin or the owner
    or (public.is_team_admin(team_id) and role = 'member')
  );

-- member_prefs: your own row, yours to write.
drop policy if exists member_prefs_select on public.member_prefs;
create policy member_prefs_select on public.member_prefs
  for select to authenticated using (public.is_team_member(team_id));
drop policy if exists member_prefs_write on public.member_prefs;
create policy member_prefs_write on public.member_prefs
  for all to authenticated
  using (user_id = auth.uid() and public.is_team_member(team_id))
  with check (user_id = auth.uid() and public.is_team_member(team_id));

-- Shared branding and test lists: everyone reads, admins write.
drop policy if exists team_settings_select on public.team_settings;
create policy team_settings_select on public.team_settings
  for select to authenticated using (public.is_team_member(team_id));
drop policy if exists team_settings_update on public.team_settings;
create policy team_settings_update on public.team_settings
  for update to authenticated using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));

drop policy if exists team_templates_select on public.team_templates;
create policy team_templates_select on public.team_templates
  for select to authenticated using (public.is_team_member(team_id));
drop policy if exists team_templates_write on public.team_templates;
create policy team_templates_write on public.team_templates
  for all to authenticated
  using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));

-- Field data: any member has full CRUD within their own team.
do $$
declare t text;
begin
  foreach t in array array[
    'clients', 'locations', 'floors', 'rooms', 'visits', 'visit_rooms', 'visit_exports'
  ] loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format(
      'create policy %I_all on public.%I for all to authenticated
         using (public.is_team_member(team_id))
         with check (public.is_team_member(team_id))', t, t);
  end loop;
end $$;
