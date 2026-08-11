-- Pemcora — several teams per person, and invitations by email.
-- Run in the Supabase SQL editor after 0004_password_reset.sql. Safe to re-run.
--
-- Select nothing before running: the editor executes only the highlighted text
-- if anything is selected, which silently runs a fragment of this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What changes, and what deliberately does not
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 0001 could already hold a person in several teams — team_members is keyed on
-- (team_id, user_id) and my_teams() has always returned every membership. Only
-- the app was single-team, taking the first row and ignoring the rest. So this
-- migration adds no new shape to membership; it adds the things the Teams page
-- needs to talk about: a description, counts, a roster across teams, a way to
-- move somebody, and invitations.
--
-- Data does not follow a person. Every client, visit and report is keyed on
-- team_id and RLS reads membership, so moving somebody to another team ends
-- their view of the old team's work and begins their view of the new team's.
-- Nothing is copied and nothing is deleted.
--
-- Roles still move only through set_member_role, which is owner-only. Nothing
-- here gives an invitation the power to mint an admin: an invite is always
-- accepted as 'member', and a moved member arrives as 'member' too. Admin is a
-- grant inside one particular team, and carrying it silently into a different
-- team would hand someone authority in a team nobody granted it in.

-- ─────────────────────────────────────────────────────────────────────────────
-- Teams gain a description
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.teams add column if not exists description text not null default '';

-- ─────────────────────────────────────────────────────────────────────────────
-- Invitations
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The token is the credential. It goes out in an email, comes back in a link,
-- and is spent when the invited address confirms itself. An invite is never
-- proof on its own: the trigger below also requires the confirming account's
-- address to match the one invited, so knowing a token is not enough.

create table if not exists public.team_invites (
  id               uuid primary key default gen_random_uuid(),
  team_id          uuid not null references public.teams(id) on delete cascade,
  email            text not null,
  token            uuid not null default gen_random_uuid(),
  role             text not null default 'member' check (role in ('admin', 'member')),
  invited_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '7 days',
  accepted_at      timestamptz,
  accepted_user_id uuid references auth.users(id) on delete set null
);

create unique index if not exists team_invites_token_idx on public.team_invites(token);
create index        if not exists team_invites_team_idx  on public.team_invites(team_id);

-- One live invitation per address per team. An expired one still holds the
-- slot, which is why create_invite clears it first — re-inviting somebody whose
-- week ran out is the same call as inviting them the first time.
create unique index if not exists team_invites_pending_idx
  on public.team_invites(team_id, lower(email)) where accepted_at is null;

alter table public.team_invites enable row level security;
grant select, delete on table public.team_invites to authenticated;

-- Admins of the team read and revoke. INSERT and UPDATE have no policy at all:
-- invitations are minted by create_invite and spent by the trigger, both
-- SECURITY DEFINER, so no client can forge an expiry date or mark one accepted.
drop policy if exists team_invites_select on public.team_invites;
create policy team_invites_select on public.team_invites
  for select to authenticated using (public.is_team_admin(team_id));

drop policy if exists team_invites_delete on public.team_invites;
create policy team_invites_delete on public.team_invites
  for delete to authenticated using (public.is_team_admin(team_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- Team RPCs
-- ─────────────────────────────────────────────────────────────────────────────

-- create_team gains a description. The single-argument version is dropped
-- rather than left alongside: two overloads differing only by a defaulted
-- argument make create_team(p_name := '…') ambiguous, and PostgREST would
-- start refusing the call the app has always made. A one-argument call still
-- resolves to this function, so nothing older breaks.
drop function if exists public.create_team(text);

create or replace function public.create_team(p_name text, p_description text default '')
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

  insert into public.teams (name, description, invite_code)
    values (coalesce(nullif(trim(p_name), ''), 'My Team'), coalesce(trim(p_description), ''), v_code)
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

-- my_teams gains description and the two counts the Teams page lists. The
-- return type changes, which create or replace cannot do, hence the drop.
drop function if exists public.my_teams();

create or replace function public.my_teams()
returns table (
  team_id      uuid,
  name         text,
  description  text,
  invite_code  text,
  role         text,
  member_count bigint,
  admin_count  bigint
)
language sql security definer set search_path = public as $$
  select
    t.id, t.name, t.description, t.invite_code, m.role,
    (select count(*) from public.team_members x where x.team_id = t.id),
    -- Owner included: the owner is an admin for every purpose except granting
    -- admin, which is what is_team_admin() says too.
    (select count(*) from public.team_members x
      where x.team_id = t.id and x.role in ('owner', 'admin'))
  from public.team_members m
  join public.teams t on t.id = m.team_id
  where m.user_id = auth.uid()
  order by t.name;
$$;

-- Every account in every team the caller administers, which is what the Teams
-- page's roster is. team_members_list() answers the same question for one team
-- and is left alone — the Settings page still uses it.
create or replace function public.all_members_overview()
returns table (
  user_id   uuid,
  email     text,
  team_id   uuid,
  team_name text,
  role      text,
  joined_at timestamptz
)
language sql security definer set search_path = public, auth as $$
  select m.user_id, u.email::text, m.team_id, t.name, m.role, m.created_at
  from public.team_members m
  join public.teams t on t.id = m.team_id
  join auth.users u on u.id = m.user_id
  where public.is_team_admin(m.team_id)
  order by t.name,
           case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
           u.email;
$$;

/**
 * Invite somebody to a team. Owner or admin; always as a member.
 *
 * Returns the whole row, token included, because the caller is the one who has
 * to deliver it — the Edge Function that emails the link, or the page that
 * offers it to copy when no mailer is configured.
 */
create or replace function public.create_invite(p_team_id uuid, p_email text)
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

  -- Replaces anything outstanding, so re-inviting after the week runs out is
  -- the same call as inviting the first time.
  delete from public.team_invites
   where team_id = p_team_id and lower(email) = v_email and accepted_at is null;

  insert into public.team_invites (team_id, email, invited_by)
    values (p_team_id, v_email, auth.uid())
    returning * into v_invite;

  return v_invite;
end;
$$;

/**
 * What a link's token is worth, asked by somebody who is not signed in.
 *
 * Answers for spent and expired tokens too, so the sign-up screen can say which
 * it was rather than "no". Returns no rows for a token that never existed.
 * Nothing here is worth guessing for: an address the guesser supplied, and a
 * team name.
 */
create or replace function public.invite_preview(p_token uuid)
returns table (email text, team_name text, expired boolean, accepted boolean)
language sql security definer set search_path = public as $$
  select i.email, t.name, i.expires_at <= now(), i.accepted_at is not null
  from public.team_invites i
  join public.teams t on t.id = i.team_id
  where i.token = p_token;
$$;

/**
 * Accept an invitation as somebody who already has an account.
 *
 * The trigger below covers the ordinary case — a new account created from the
 * link — but an existing user clicking one has a session and a confirmed
 * address already, and no confirmation is coming to hang the membership off.
 * The address still has to match: the token alone is not proof.
 */
create or replace function public.accept_invite(p_token uuid)
returns public.teams language plpgsql security definer set search_path = public, auth as $$
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
  if v_invite.expires_at <= now() then
    raise exception 'That invitation has expired. Ask for a new one.';
  end if;
  if lower(v_invite.email) <> v_email then
    raise exception 'That invitation was sent to %, not to you', v_invite.email;
  end if;

  insert into public.team_members (team_id, user_id, role)
    values (v_invite.team_id, v_uid, v_invite.role)
    on conflict (team_id, user_id) do nothing;
  insert into public.member_prefs (team_id, user_id)
    values (v_invite.team_id, v_uid)
    on conflict (team_id, user_id) do nothing;

  update public.team_invites
     set accepted_at = now(), accepted_user_id = v_uid
   where id = v_invite.id;

  select * into v_team from public.teams where id = v_invite.team_id;
  return v_team;
end;
$$;

/**
 * Move somebody from one team to another. Owner of both, and never the owner
 * of the team being left.
 *
 * They arrive as a member whatever they were before — see the header. Their
 * work does not travel with them: it belongs to the team, and this changes
 * only which team they can see.
 */
create or replace function public.move_member(p_user_id uuid, p_from_team_id uuid, p_to_team_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  if p_from_team_id = p_to_team_id then raise exception 'That is the team they are already in'; end if;
  if not public.is_team_owner(p_from_team_id) or not public.is_team_owner(p_to_team_id) then
    raise exception 'You must own both teams to move someone between them';
  end if;

  select role into v_role
    from public.team_members
   where team_id = p_from_team_id and user_id = p_user_id;

  if v_role is null then raise exception 'That person is not in that team'; end if;
  if v_role = 'owner' then
    raise exception 'A team owner cannot be moved out of their own team. Transfer ownership first.';
  end if;
  if exists (
    select 1 from public.team_members where team_id = p_to_team_id and user_id = p_user_id
  ) then
    raise exception 'They are already in that team';
  end if;

  update public.team_members
     set team_id = p_to_team_id, role = 'member'
   where team_id = p_from_team_id and user_id = p_user_id;

  update public.member_prefs
     set team_id = p_to_team_id
   where team_id = p_from_team_id and user_id = p_user_id;
end;
$$;

grant execute on function public.create_team(text, text)          to authenticated;
grant execute on function public.my_teams()                       to authenticated;
grant execute on function public.all_members_overview()           to authenticated;
grant execute on function public.create_invite(uuid, text)        to authenticated;
grant execute on function public.accept_invite(uuid)              to authenticated;
grant execute on function public.move_member(uuid, uuid, uuid)    to authenticated;
-- anon as well: the whole point is to be readable before there is an account.
grant execute on function public.invite_preview(uuid)             to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Spending an invitation on email confirmation
-- ─────────────────────────────────────────────────────────────────────────────
--
-- "Successful account creation is confirmed when the user's email is verified",
-- so that is where the membership is created — not at sign-up, which anyone can
-- do to any address. The token travels in raw_user_meta_data because that is
-- the only thing that survives from signUp() through the confirmation email to
-- here.
--
-- The whole body is wrapped in an exception handler and it always returns NEW.
-- This trigger runs inside GoTrue's own transaction: anything raised here would
-- roll back the confirmation itself, and a mangled invitation must never be
-- able to stop somebody verifying their email.

create or replace function public.consume_invite_on_confirm()
returns trigger language plpgsql security definer set search_path = public, auth as $$
declare
  v_token  uuid;
  v_invite public.team_invites;
begin
  if new.email_confirmed_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.email_confirmed_at is not null then return new; end if;

  begin
    v_token := nullif(new.raw_user_meta_data ->> 'invite_token', '')::uuid;
    if v_token is null then return new; end if;

    select * into v_invite
      from public.team_invites
     where token = v_token and accepted_at is null and expires_at > now()
       for update;

    if v_invite.id is null then return new; end if;
    -- The token is not proof by itself. Whoever confirms has to be the address
    -- that was invited, so a leaked link cannot be redeemed by somebody else.
    if lower(v_invite.email) <> lower(new.email) then return new; end if;

    insert into public.team_members (team_id, user_id, role)
      values (v_invite.team_id, new.id, v_invite.role)
      on conflict (team_id, user_id) do nothing;
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

drop trigger if exists consume_invite_on_confirm on auth.users;
create trigger consume_invite_on_confirm
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.consume_invite_on_confirm();

-- PostgREST caches the schema; without this the new functions 404 until the
-- next restart.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — every count below should be 1, and my_teams should return
-- your own teams with their counts filled in.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'teams'
      and column_name = 'description')                                as teams_description,
  (select count(*) from pg_tables
    where schemaname = 'public' and tablename = 'team_invites')       as tbl_team_invites,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'team_invites'
      and c.relrowsecurity)                                           as invites_rls_on,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_invite')       as fn_create_invite,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'invite_preview')      as fn_invite_preview,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'accept_invite')       as fn_accept_invite,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'move_member')         as fn_move_member,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'all_members_overview') as fn_all_members,
  (select count(*) from pg_trigger
    where tgname = 'consume_invite_on_confirm' and not tgisinternal)  as trg_consume_invite,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_team'
      and p.pronargs = 2)                                             as fn_create_team_2args;

select * from public.my_teams();
