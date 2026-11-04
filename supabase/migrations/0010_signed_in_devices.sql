-- ─────────────────────────────────────────────────────────────────────────────
-- 0010 — the devices signed in to your account, and signing one out
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Build plan C5 (M.D.'s note, 3 November). Sign out ends the login on the device
-- it's pressed on. A lost phone, or a laptop that was stolen, has to be signed
-- out from another device.
--
-- Each login is a row in auth.sessions, which no client can read: it holds every
-- account's logins, with their IP addresses. These two functions open one narrow
-- view of it, to the person signed in, about their own logins only.
--
--   my_devices()           each of your logins: its id, the browser details it
--                          signed in with, when, and when it was last renewed.
--                          No tokens, no IP address.
--   end_device(session)    deletes one of your logins. Its refresh tokens go
--                          with it (on delete cascade, checked on the live project
--                          4 November), so that device can't renew. Anyone else's
--                          is refused, the same way as one that doesn't exist.
--
-- The device's current access token keeps working until it runs out, up to the
-- project's token lifetime: nothing here can recall one already issued.
--
-- SECURITY DEFINER, because auth.sessions is closed to the caller; each checks
-- whose login it is itself. Granted to signed-in users only.
--
-- Safe to re-run. Applied by M.D. in the Supabase SQL editor, after 0009.

create or replace function public.my_devices()
returns table (
  id           uuid,
  user_agent   text,
  signed_in_at timestamptz,
  last_used_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select s.id,
         coalesce(s.user_agent, ''),
         s.created_at,
         -- refreshed_at is a timestamp in UTC, with no time zone of its own.
         coalesce(s.refreshed_at at time zone 'utc', s.updated_at, s.created_at)
    from auth.sessions s
   where s.user_id = auth.uid()
     and (s.not_after is null or s.not_after > now())
   order by 4 desc nulls last, s.created_at desc;
$$;

create or replace function public.end_device(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  delete from auth.sessions s
   where s.id = p_session_id
     and s.user_id = auth.uid();

  -- Someone else's login reads exactly as one that doesn't exist: nothing here
  -- says whether it does.
  if not found then
    raise exception 'That device is already signed out, or isn''t one of yours'
      using errcode = 'P0002', hint = 'not_yours';
  end if;
end;
$$;

revoke execute on function public.my_devices()     from public, anon;
revoke execute on function public.end_device(uuid) from public, anon;
grant  execute on function public.my_devices()     to authenticated;
grant  execute on function public.end_device(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — definers 2, members_can_list and members_can_end true, the
-- rest false.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('my_devices', 'end_device') and p.prosecdef)  as definers,
  has_function_privilege('authenticated', 'public.my_devices()', 'execute')                   as members_can_list,
  has_function_privilege('authenticated', 'public.end_device(uuid)', 'execute')               as members_can_end,
  has_function_privilege('anon', 'public.my_devices()', 'execute')                            as anon_can_list,
  has_function_privilege('anon', 'public.end_device(uuid)', 'execute')                        as anon_can_end,
  has_table_privilege('authenticated', 'auth.sessions', 'select')                             as members_read_sessions;
