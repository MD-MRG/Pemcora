-- Pemcora — two fields the app has always written but the schema had nowhere to put.
-- Run in the Supabase SQL editor after 0002_grants.sql. Safe to re-run.
--
-- Found while porting clientStore.js onto lib/api.js: both of these are written
-- by the app today and would have been silently dropped on the way to Postgres.
-- A field that vanishes on save is worse than one that was never offered.
--
--   visits.export_preference  — the remembered replace-vs-revise answer.
--     WorkflowPage reads it to decide whether to ask again on re-export; without
--     it every export re-prompts and the "don't ask again" tick does nothing.
--     Belongs on the visit, not the device: the choice is about that report.
--
--   visit_exports.filename    — the name the file went out under.
--     The report regenerates its filename from the client, visit and revision,
--     so this is not needed to rebuild anything. It is the record of what was
--     actually sent, which is the part nobody can reconstruct later.
--
-- Both are nullable with no default: rows written before this migration
-- genuinely did not have a value, and inventing one would misreport history.

alter table public.visits
  add column if not exists export_preference text
  check (export_preference is null or export_preference in ('revision', 'replace'));

alter table public.visit_exports
  add column if not exists filename text;

-- No grant statements needed: 0002 granted at table level, which covers columns
-- added later. Verify anyway — a silent privilege gap here would look exactly
-- like the app failing to save.

select
  table_name,
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('visits', 'export_preference'),
    ('visit_exports', 'filename')
  )
order by table_name, column_name;
