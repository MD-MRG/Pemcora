-- ─────────────────────────────────────────────────────────────────────────────
-- 0022 — room photos: photos kept with a site's room
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A room can hold photos, each with a description and the date it was added
-- (M.D., 13 November). They belong to the room, not to a visit, so every
-- visit's report shows them. They're rows in attachments (0007), the same as an
-- item's label photo, with the file in the team's own folder of the private
-- evidence bucket: '<team_id>/rooms/<room_id>/<uuid>.jpg'.
--
--   attachments.room_id     the room, in the same team. Deleting the room
--                           deletes its photos' records; the app removes their
--                           files first, as storage can't follow a foreign key.
--   attachments_stamp       the date a photo was added is the server's clock,
--                           never the device's, so nobody can backdate one onto
--                           an old report. It and who added it can't be changed
--                           afterwards. Covers label photos too.
--   caption                 at most 300 characters.
--
-- Photos stay Pro, unchanged: gate_attachment() on the record and
-- can_add_evidence() on the upload, both only once app_settings.enforce_limits
-- is on. With the switch off, as it is on the live project, every team can add
-- them.
--
-- Numbered after Phase E's 0015–0021 but doesn't need them, and is applied
-- before them. 0020's worker-only rules for attachments are separate
-- (restrictive) policies and a trigger of their own, so this leaves them be
-- whichever order the two arrive in.
--
-- Safe to re-run. Applied by M.D. in the Supabase SQL editor.

-- ── The room ───────────────────────────────────────────────────────────────
alter table public.attachments
  add column if not exists room_id uuid references public.rooms(id) on delete cascade;
create index if not exists attachments_room_idx on public.attachments(room_id);

-- ── A description of at most 300 characters ────────────────────────────────
-- Every caption on the live project is 'Label' (the label photos), so this
-- validates at once.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'attachments_caption_length'
                    and conrelid = 'public.attachments'::regclass) then
    alter table public.attachments
      add constraint attachments_caption_length check (char_length(caption) <= 300);
  end if;
end $$;

-- ── When it was added, and by whom: the server's word ──────────────────────
-- On insert, taken_at is now() whatever the app sent, and created_by is the
-- signed-in person (left as given when nobody is: the SQL editor or the
-- service_role key). On update, both keep what they had, so a description can
-- be edited but the date can't be moved back. Invoker rights: it only sets the
-- row's own fields.
create or replace function public.stamp_attachment()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.taken_at   := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.taken_at   := old.taken_at;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
revoke execute on function public.stamp_attachment() from public, anon, authenticated;

drop trigger if exists attachments_stamp on public.attachments;
create trigger attachments_stamp before insert or update on public.attachments
  for each row execute function public.stamp_attachment();

-- ── Same-team room ─────────────────────────────────────────────────────────
-- 0007's policy, with the room checked as the visit, visit room and item are.
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
    and (attachments.room_id is null
         or exists (select 1 from public.rooms r
                     where r.id = attachments.room_id and r.team_id = attachments.team_id))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — col_room_id 1, idx_room 1, caption_check 1, trg_stamp 1,
-- trg_photo_gate 1, policy_checks_room true, stamp_exposed 0,
-- rooms_in_other_team 0.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'attachments'
      and column_name = 'room_id')                                         as col_room_id,
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'attachments_room_idx')    as idx_room,
  (select count(*) from pg_constraint
    where conname = 'attachments_caption_length'
      and conrelid = 'public.attachments'::regclass)                       as caption_check,
  (select count(*) from pg_trigger
    where tgname = 'attachments_stamp' and not tgisinternal)               as trg_stamp,
  (select count(*) from pg_trigger
    where tgname = 'attachments_gate' and not tgisinternal)                as trg_photo_gate,
  (select coalesce(bool_or(with_check like '%rooms r%'), false) from pg_policies
    where schemaname = 'public' and tablename = 'attachments'
      and policyname = 'attachments_all')                                  as policy_checks_room,
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'stamp_attachment'
      and grantee in ('anon', 'authenticated', 'PUBLIC'))                  as stamp_exposed,
  (select count(*) from public.attachments x join public.rooms r on r.id = x.room_id
    where r.team_id <> x.team_id)                                          as rooms_in_other_team;
