-- ─────────────────────────────────────────────────────────────────────────────
-- 0022 — room photos: photos kept with a site's room
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A room can hold photos in two groups, General and Issues, each with a
-- description and the date it was added (M.D., 13 November). They belong to
-- the room, not to a visit, so every visit's report can show them. They're rows
-- in attachments (0007), the same as an item's label photo, with two files in
-- the team's own folder of the private evidence bucket, under
-- '<team_id>/rooms/<room_id>/': a display copy (storage_path, 1600 px) and the
-- best full-quality JPEG that fits the bucket (original_path), for download.
--
--   attachments.room_id       the room, in the same team. Deleting the room
--                             deletes its photos' records; the app removes their
--                             files first, as storage can't follow a foreign key.
--   attachments.category      'general' or 'issue': required on a room photo,
--                             always empty on a label photo. A photo moves
--                             between groups by changing it.
--   attachments.original_path the full-quality file, in the team's own folder.
--   attachments_stamp         the date a photo was added is the server's clock,
--                             never the device's, so nobody can backdate one onto
--                             an old report. Who added it, its team, room and
--                             files can't be changed afterwards either; only its
--                             description and group can. Covers label photos too.
--   caption                   at most 300 characters.
--
-- Who gets room photos. For now only teams M.D. switches on, in team_features,
-- from the SQL editor: nobody can write that table from the app. Once
-- app_settings.enforce_limits is on, Pro teams get them too. Checked on the
-- record (gate_attachment) and on the upload (a restrictive storage policy for
-- the rooms/ folder); room_photos_allowed() tells the app. Label photos keep
-- their rule: Pro, only once limits are on.
--
-- Numbered after Phase E's 0015–0021 but doesn't need them, and is applied
-- before them. It leaves team_entitlements() alone (0020 and 0021 redefine it)
-- and 0020's worker-only rules, which are separate restrictive policies and a
-- trigger of their own, so either order works.
--
-- Safe to re-run. Applied by M.D. in the Supabase SQL editor.

-- ── The room, the group, the full-quality file ─────────────────────────────
alter table public.attachments
  add column if not exists room_id uuid references public.rooms(id) on delete cascade;
alter table public.attachments add column if not exists category text;
alter table public.attachments add column if not exists original_path text;
create index if not exists attachments_room_idx on public.attachments(room_id);

-- Every attachment on the live project is a label photo with a caption of
-- 'Label' and no room, so these validate at once.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'attachments_caption_length'
                    and conrelid = 'public.attachments'::regclass) then
    alter table public.attachments
      add constraint attachments_caption_length check (char_length(caption) <= 300);
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'attachments_category_valid'
                    and conrelid = 'public.attachments'::regclass) then
    alter table public.attachments
      add constraint attachments_category_valid check (category in ('general', 'issue'));
  end if;
  -- A room photo has a group; a label photo has none.
  if not exists (select 1 from pg_constraint
                  where conname = 'attachments_room_category'
                    and conrelid = 'public.attachments'::regclass) then
    alter table public.attachments
      add constraint attachments_room_category check ((room_id is null) = (category is null));
  end if;
end $$;

-- ── Which teams have room photos ───────────────────────────────────────────
-- One row per team M.D. switches on. No privileges for anon or authenticated,
-- so it's read only through the functions below and written only from the SQL
-- editor.
create table if not exists public.team_features (
  team_id     uuid primary key references public.teams(id) on delete cascade,
  room_photos boolean not null default false,
  updated_at  timestamptz not null default now()
);
alter table public.team_features enable row level security;
revoke all on table public.team_features from anon, authenticated;

-- Whether a team may add room photos: switched on, or Pro once limits are on.
-- For the database's own checks; not callable from the app.
create or replace function public.room_photos_on(_team_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select f.room_photos from public.team_features f where f.team_id = _team_id), false)
      or (public.limits_enforced() and public.team_is_pro(_team_id));
$$;
revoke execute on function public.room_photos_on(uuid) from public, anon, authenticated;

-- The same question for the app, answered only about the caller's own teams.
create or replace function public.room_photos_allowed(p_team_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.is_team_member(p_team_id) and public.room_photos_on(p_team_id);
$$;
revoke execute on function public.room_photos_allowed(uuid) from public, anon;
grant  execute on function public.room_photos_allowed(uuid) to authenticated;

-- ── The gate on the record ─────────────────────────────────────────────────
-- 0007's gate, with room photos checked by their own rule. A refusal carries
-- the code the app's upgrade sheet looks for.
create or replace function public.gate_attachment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.room_id is not null then
    if not public.room_photos_on(new.team_id) then
      raise exception 'Room photos are not available to this team'
        using errcode = 'PT402', hint = 'upgrade';
    end if;
  elsif public.limits_enforced() and not public.team_is_pro(new.team_id) then
    raise exception 'Photo evidence is part of Pro'
      using errcode = 'PT402', hint = 'upgrade';
  end if;
  return new;
end;
$$;
revoke execute on function public.gate_attachment() from public, anon, authenticated;

drop trigger if exists attachments_gate on public.attachments;
create trigger attachments_gate before insert on public.attachments
  for each row execute function public.gate_attachment();

-- ── The gate on the upload ─────────────────────────────────────────────────
-- The rooms/ folder follows the room-photo rule, not 0007's Pro rule: a
-- switched-on team on Free can upload there once limits are on (permissive,
-- alongside 0007's evidence policy), and a team without room photos can't
-- (restrictive, narrowing both for that folder only).
drop policy if exists pemcora_room_photos_upload on storage.objects;
create policy pemcora_room_photos_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'evidence'
              and split_part(name, '/', 2) = 'rooms'
              and public.room_photos_allowed(public.path_team(name)));

drop policy if exists pemcora_room_photos_insert on storage.objects;
create policy pemcora_room_photos_insert on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id <> 'evidence'
              or split_part(name, '/', 2) <> 'rooms'
              or public.room_photos_allowed(public.path_team(name)));

-- ── When it was added, by whom, and what it is: the server's word ──────────
-- On insert, taken_at is now() whatever the app sent, and created_by is the
-- signed-in person (left as given when nobody is: the SQL editor or the
-- service_role key). On update, only the description and the group may change,
-- and the foreign keys may empty the item and the person: anything else is
-- refused. Invoker rights: it reads only the row itself.
create or replace function public.stamp_attachment()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.taken_at   := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
  elsif new.team_id       is distinct from old.team_id
     or new.room_id       is distinct from old.room_id
     or new.visit_id      is distinct from old.visit_id
     or new.visit_room_id is distinct from old.visit_room_id
     or new.storage_path  is distinct from old.storage_path
     or new.original_path is distinct from old.original_path
     or new.taken_at      is distinct from old.taken_at
     -- These two are emptied by their foreign keys (on delete set null) when
     -- the item or the person is deleted, which has to go through.
     or (new.asset_id   is distinct from old.asset_id   and new.asset_id   is not null)
     or (new.created_by is distinct from old.created_by and new.created_by is not null) then
    raise exception 'Only a photo''s description and group can be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.stamp_attachment() from public, anon, authenticated;

drop trigger if exists attachments_stamp on public.attachments;
create trigger attachments_stamp before insert or update on public.attachments
  for each row execute function public.stamp_attachment();

-- ── Same-team room, and both files in the team's folder ────────────────────
-- 0007's policy, with the room and the full-quality file checked as the
-- visit, visit room, item and display file are.
drop policy if exists attachments_all on public.attachments;
create policy attachments_all on public.attachments
  for all to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and public.path_team(attachments.storage_path) = attachments.team_id
    and (attachments.original_path is null
         or public.path_team(attachments.original_path) = attachments.team_id)
    and (attachments.visit_id is null
         or exists (select 1 from public.visits v
                     where v.id = attachments.visit_id and v.team_id = attachments.team_id))
    and (attachments.visit_room_id is null
         or exists (select 1 from public.visit_rooms vr
                     where vr.id = attachments.visit_room_id and vr.team_id = attachments.team_id))
    and (attachments.asset_id is null
         or exists (select 1 from public.assets a
                     where a.id = attachments.asset_id and a.team_id = attachments.team_id))
    and (attachments.room_id is null
         or exists (select 1 from public.rooms r
                     where r.id = attachments.room_id and r.team_id = attachments.team_id))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — cols 3, idx_room 1, checks 3, trg_stamp 1, trg_photo_gate 1,
-- policy_checks_room true, rooms_upload_gate 2, features_rls_on 1,
-- features_exposed 0, fn_allowed 1, internal_exposed 0, rooms_in_other_team 0.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'attachments'
      and column_name in ('room_id', 'category', 'original_path'))         as cols,
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'attachments_room_idx')    as idx_room,
  (select count(*) from pg_constraint
    where conrelid = 'public.attachments'::regclass
      and conname in ('attachments_caption_length', 'attachments_category_valid',
                      'attachments_room_category'))                        as checks,
  (select count(*) from pg_trigger
    where tgname = 'attachments_stamp' and not tgisinternal)               as trg_stamp,
  (select count(*) from pg_trigger
    where tgname = 'attachments_gate' and not tgisinternal)                as trg_photo_gate,
  (select coalesce(bool_or(with_check like '%rooms r%'), false) from pg_policies
    where schemaname = 'public' and tablename = 'attachments'
      and policyname = 'attachments_all')                                  as policy_checks_room,
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('pemcora_room_photos_insert', 'pemcora_room_photos_upload')) as rooms_upload_gate,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'team_features'
      and c.relrowsecurity)                                                as features_rls_on,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'team_features'
      and grantee in ('anon', 'authenticated'))                            as features_exposed,
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'room_photos_allowed'
      and grantee = 'authenticated')                                       as fn_allowed,
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('room_photos_on', 'stamp_attachment', 'gate_attachment')
      and grantee in ('anon', 'authenticated', 'PUBLIC'))                  as internal_exposed,
  (select count(*) from public.attachments x join public.rooms r on r.id = x.room_id
    where r.team_id <> x.team_id)                                          as rooms_in_other_team;
