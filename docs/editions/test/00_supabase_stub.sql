-- Test-only: just enough of Supabase for the migrations to run on plain Postgres.
-- Roles, auth.users, auth.uid(), a storage schema, and Supabase's default
-- privileges (new tables and functions in public are granted to anon and
-- authenticated, so RLS is the only gate — exactly as on a real project).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at         timestamptz not null default now()
);

-- Each login, and its renewal tokens, with the live project's column types
-- (refreshed_at has no time zone and is UTC) and its cascade, checked 4 November.
-- No client role gets anything on them, as on Supabase.
create table auth.sessions (
  id           uuid primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz,
  updated_at   timestamptz,
  not_after    timestamptz,
  refreshed_at timestamp,
  user_agent   text,
  ip           inet,
  tag          text
);
create table auth.refresh_tokens (
  id         bigserial primary key,
  token      varchar,
  user_id    varchar,
  revoked    boolean,
  created_at timestamptz,
  updated_at timestamptz,
  parent     varchar,
  session_id uuid references auth.sessions(id) on delete cascade
);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (
  id     text primary key,
  name   text not null,
  public boolean not null default false
);
create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
