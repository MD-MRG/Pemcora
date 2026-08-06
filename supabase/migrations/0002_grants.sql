-- Pemcora — explicit table privileges for the `authenticated` role.
-- Run in the Supabase SQL editor after 0001_init.sql. Safe to re-run.
--
-- Why this exists as its own migration:
--
-- RLS policies and table privileges are two separate gates and BOTH must pass.
-- A policy saying "members may read their team" does nothing if the role lacks
-- GRANT SELECT — Postgres refuses with 42501 before RLS is ever consulted.
--
-- 0001 granted EXECUTE on the RPCs but no table privileges, relying on
-- Supabase's default privileges for the public schema. Probing the REST API
-- with the publishable key showed `anon` denied on every table, which is
-- correct and desirable — but it does not prove `authenticated` was granted,
-- and that cannot be checked from outside without a signed-in user.
--
-- So make it explicit. A migration that only works because of an undocumented
-- dashboard default is a migration that breaks silently on the next project.
-- If the grants are already there this whole file is a no-op.
--
-- `anon` is deliberately given nothing: every policy in 0001 is `to
-- authenticated`, so an anonymous caller should see nothing at all.

grant usage on schema public to authenticated;

grant select, insert, update, delete on table
  public.teams,
  public.team_members,
  public.member_prefs,
  public.team_settings,
  public.team_templates,
  public.clients,
  public.locations,
  public.floors,
  public.rooms,
  public.visits,
  public.visit_rooms,
  public.visit_exports
to authenticated;

-- team_members is intentionally NOT updatable by anyone: roles move only through
-- set_member_role / transfer_ownership, which are SECURITY DEFINER. Revoke the
-- privilege as well as omitting the policy, so there are two locks not one.
revoke update on table public.team_members from authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — this returns rows, unlike the rest of the migration.
-- Every table should appear with the privileges listed, and `anon` should not
-- appear at all.
-- ─────────────────────────────────────────────────────────────────────────────

select
  table_name,
  grantee,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('authenticated', 'anon')
group by table_name, grantee
order by table_name, grantee;
