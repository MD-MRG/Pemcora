# SQL-level checks for 0006 to 0010

`run_tests.py` builds a throwaway database from the real `supabase/migrations/0001–0005`,
makes a team the way the app used to, applies `0006` to `0010` twice (re-run
safety), then drives every gate, policy and RPC as real signed-in roles with RLS on.
396 checks: grandfathering, the enforcement switch, packs, the monthly allowance,
seats and invites, the column lock on `teams`, the re-check clock, photo gating,
storage folders, and the whole report delivery → claim → auto-file loop. Then
the build plan's Phase A rules: a second device joining an open visit, visit
dates and the one-time import window, the 7-day payment grace and `cancel_at`,
the catalogue and no silent AV, seat races and notices, regular intervals, the
Due list, reminder switches and opt-outs, hand-entered checks, report link
expiry and "Send again", and the sign-off on a delivered report. Last, one block
per finding of the pre-A4 security review (F1–F11, including two races run on
two connections) and per review note that was decided (reopened visits, the
grace clock, sign-off stamps, emailed opt-outs, starter swaps, deleted landlord
accounts), then step A3b: the re-checks' R1–R7 and S1–S3, and the cases found checking them,
and step B5: every row of the starter table in 2.3, who can delete a report record, and what a
signed-out caller can reach.
The R6 and R7 blocks re-run the drafts, so they stay last, and B5 checks again after them that
re-running 0006 and 0007 by themselves doesn't undo 0008. Last, step C4: `due_opt_outs()` for
the team's own members only, including a check made again with the contact's email blank, and
0009 re-run after everything else. Then step C5: `my_devices()` and `end_device()` for the person's
own logins only, refresh tokens going with an ended login, nothing for a signed-out caller, and
0010 re-run last.

`00_supabase_stub.sql` stands in for the parts of Supabase plain Postgres lacks:
the `anon` / `authenticated` / `service_role` roles, `auth.users`, `auth.sessions` and
`auth.refresh_tokens` (with the live column types and cascade), `auth.uid()`,
a minimal `storage` schema, and Supabase's default privileges.

## Running it

Needs Postgres 16 you don't mind it creating roles on (never Supabase itself), and
`pip install "psycopg[binary]"`. From the repo root:

```
PGHOST=localhost PGUSER=postgres python3 docs/editions/test/run_tests.py supabase/migrations
```

It drops and recreates a database called `pemcora_editions_test`. Exit code is 0
only if every check passes.

This proves the SQL. It does not replace `tests/rls.mjs`, which proves the same
boundaries through the real Supabase API — extend that one as the features land.
