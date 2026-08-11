-- Pemcora — the one thing a password reset needs from the database.
-- Run in the Supabase SQL editor after 0003_export_fields.sql. Safe to re-run.
--
-- Select nothing before running: the editor executes only the highlighted text
-- if anything is selected, which silently runs a fragment of this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why this exists, and what it costs
-- ─────────────────────────────────────────────────────────────────────────────
--
-- auth.resetPasswordForEmail reports success whether or not the address has an
-- account. That is deliberate on GoTrue's part — it stops the reset form being
-- used as a directory of who has signed up. The cost is that a technician who
-- mistypes their address on a job site is told an email is on its way, and then
-- waits for one that will never arrive.
--
-- Pemcora chooses the other side of that trade: the app says "there is no
-- account for that address" and the person fixes the typo. Doing so does hand
-- an attacker a way to test addresses one at a time, so:
--
--   * the function answers a bare boolean and nothing else — no name, no id,
--     no hint about whether the address is confirmed;
--   * every call is logged against the caller's IP and refused past 20 in a
--     minute, which is far above what a human retyping an address produces and
--     far below what enumerating a list requires;
--   * the log holds an IP and a timestamp, is readable by nobody through the
--     API, and prunes itself.

-- ─────────────────────────────────────────────────────────────────────────────
-- Throttle log
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.email_probe_log (
  ip        text        not null,
  probed_at timestamptz not null default now()
);
create index if not exists email_probe_log_ip_idx on public.email_probe_log(ip, probed_at desc);

-- RLS on with no policies at all: the only reader is the SECURITY DEFINER
-- function below, which bypasses it. Anything arriving through PostgREST sees
-- an empty table. `authenticated` is granted nothing here on purpose.
alter table public.email_probe_log enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- The lookup
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.email_is_registered(p_email text)
returns boolean language plpgsql security definer set search_path = public, auth as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_ip    text;
  v_hits  int;
begin
  if v_email = '' or position('@' in v_email) = 0 then
    return false;
  end if;

  -- PostgREST forwards the request headers; the proxy in front of it sets
  -- x-forwarded-for. When neither is present every caller shares one bucket,
  -- which throttles harder rather than softer — the safe direction to fail.
  v_ip := coalesce(
    split_part(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for',
      ',', 1),
    'unknown');

  delete from public.email_probe_log where probed_at < now() - interval '10 minutes';

  select count(*) into v_hits
  from public.email_probe_log
  where ip = v_ip and probed_at > now() - interval '1 minute';

  if v_hits >= 20 then
    raise exception 'Too many attempts. Wait a minute and try again.'
      using errcode = '53400';
  end if;

  insert into public.email_probe_log (ip) values (v_ip);

  return exists (select 1 from auth.users u where lower(u.email) = v_email);
end;
$$;

-- anon, because nobody signing in is authenticated yet. `authenticated` too, so
-- the same screen works for someone already signed in on another tab.
grant execute on function public.email_is_registered(text) to anon, authenticated;

-- PostgREST caches the schema; without this the new function 404s until the
-- next restart.
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — every number below should be 1 except probe_rows.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'email_is_registered')      as fn_email_is_registered,
  (select count(*) from pg_tables
    where schemaname = 'public' and tablename = 'email_probe_log')         as tbl_probe_log,
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'email_probe_log'
      and c.relrowsecurity)                                               as probe_log_rls_on,
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'email_is_registered'
      and grantee = 'anon')                                               as anon_can_execute,
  (select count(*) from public.email_probe_log)                           as probe_rows;
