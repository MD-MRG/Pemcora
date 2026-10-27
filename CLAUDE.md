# Pemcora

A field app for AV preventative maintenance and commissioning visits, being rebuilt as one
app sold in editions: AV maintenance, rental electrical and smoke alarm compliance for
electricians, and a side for landlords and agencies who receive the reports.

Stack: React 19, Vite, Tailwind v4, HashRouter, ExcelJS. Supabase for Postgres, Auth,
Storage and Edge Functions. `.github/workflows/deploy.yml` deploys the live site to GitHub
Pages on every push to `main`.

## The editions build

- The plan is `docs/editions/build-plan.md`: 0 how to work, 1 context, 2 product rules,
  3 pack test lists, 4 phases A–H, 5 open decisions, 6 known limits.
- Work through it phase by phase, in order. Before each step, read section 0, the
  section 2 rules the step refers to, and the step itself.
- Parts marked **M.D.'s note** are decisions already made.
- `docs/editions/data-model.md` explains the drafted database. Where it and the plan
  differ, the plan wins.
- `docs/editions/0006_editions.sql` and `0007_compliance_and_reports.sql` are drafts that
  have never been applied. Phase A edits them in place; step A4 moves them into
  `supabase/migrations/`.
- The `vic_rental`, `qld_electrical` and `electrical_general` test lists are proposals.
  A licensed electrician checks them before they ship.
- Section 5 decisions use their listed defaults. Settle D1 and D2 (pricing and add-ons)
  with M.D. at the start of Phase E, not before.
- If the plan doesn't fit the code, stop and ask M.D. instead of improvising.

## Rules

- Never apply a migration to the live Supabase project, deploy an Edge Function or
  change Stripe without M.D.'s go-ahead.
- `app_settings.enforce_limits` stays `false` until step E6.
- The Supabase service_role key never goes in client code, the build or the deploy
  workflow.
- Today's AV app must keep working after every step.
- Migrations are safe to re-run and end with a verification query, like 0001–0005.
- Row-Level Security and table privileges are two separate locks; use both.
  `SECURITY DEFINER` only where a rule needs it.
- Test lists live in code (`src/data/`), never in SQL.
- Every workflow uses the one `src/workflows/WorkflowPage.jsx`, configured per
  workflow. Never copy it.
- Work on a branch for each phase: one commit per step, one pull request per phase.
  Ask M.D. before any push; a push to `main` deploys the live site.
- Never commit `.env` or `supabase/.temp/`.

## Checks after each step

- `npm run lint`, then the affected `tests/*.mjs` suites (`npm test` runs them all).
- When SQL changed, run the SQL suite from the repo root:
  `PGHOST=localhost PGUSER=postgres python3 docs/editions/test/run_tests.py supabase/migrations docs/editions`
  It needs a local Postgres 16 and `pip install "psycopg[binary]"`. It drops and
  recreates a database called `pemcora_editions_test`. Never point it at Supabase.
- Add tests for anything new.
