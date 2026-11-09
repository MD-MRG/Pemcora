# SQL-level checks for 0006 to 0014

`run_tests.py` builds a throwaway database from the real `supabase/migrations/0001–0005`,
makes a team the way the app used to, applies `0006` to `0014` twice (re-run
safety), then drives every gate, policy and RPC as real signed-in roles with RLS on.
458 checks: grandfathering, the enforcement switch, packs, the monthly allowance,
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
0010 re-run last. Then step D2: the daily send cap (10 on Free, 50 on Pro, each team its own,
"Send again" counted, a withdrawn report's send not given back, a send older than 24 hours no
longer counting), a report with a note still saying `[timeframe]` refused, the send log and its
helpers closed to clients, and 0011 re-run after everything else, since re-running 0007 by
itself puts back `send_report()` without the cap. Then step D3b: with the service-role key, the
`report-file` function's lookup works, and nothing else on `report_deliveries` does (not the
recipient's address, the report, every column, or a change), and 0012 re-runs. Then step D4a:
the account a report was saved to reads it only through `received_reports()`, without the
sender's ids inside or out; the sender still reads its own row; nobody else gets either; the
saved account still reads the PDF, and the PDF check answers only for the asker's own; the
landlord sees whether a report files itself and stops it with `stop_auto_filing()`, not by
deleting the link; and 0013 re-runs after 0007's. Then step D4d: a check a landlord enters by
hand works out its next due date and moves it on when done again; the same one twice at a
property is refused, and nobody else can add one; its certificate goes in the landlord's own
folder (on Free with limits on, not at all), never names a file in another team's folder, and
nobody else can read or add one; the landlord can remove the check; and 0014 re-runs.

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
