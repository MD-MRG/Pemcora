# Verification suites

Headless browser checks driving the real app against real `localStorage`. They
seed data, click through the UI, and assert against what actually landed in the
store — not against component internals.

## Running them

The dev server must be up first, on port 5173:

```
npm run dev
```

Then, from the project root:

```
node tests/shell.mjs                   tests
node tests/pm-export.mjs               tests
```

Each script takes an optional output directory for screenshots; it defaults to
the current one. Run them from a directory you don't mind PNG files landing in.

| Suite | Covers | Checks |
|---|---|---|
| `shell.mjs` | nav, collapse to rail, drawer, brand plate | 16 |
| `new-client-form.mjs` | the six required fields, floors/rooms, focus | 18 |
| `new-client-locations.mjs` | multi-location clients, duplicate detection | 19 |
| `edit-client.mjs` | search/filter, locations, editing, renames | 29 |
| `pm-visits.mjs` | visit states, room list, add room | 22 |
| `pm-room-tests.mjs` | test lists, sections, troubleshooting, complete | 23 |
| `pm-export.mjs` | Excel export, revisions, remembered choice | 26 |

## `supabase-e2e.mjs` — the only suite that runs on the real backend

Every suite above runs in test mode on localStorage. This one deliberately does
not: it signs in through the real gate, so the app runs on the Supabase adapter,
then drives the actual UI and checks the rows **from outside the browser** —
because "it still shows on screen" could just be the in-memory cache, and the
point is to prove the data reached Postgres.

```
node tests/supabase-e2e.mjs [email] [password]
```

Needs the dev server and a confirmed account; sign-up is closed on the project,
so it defaults to reusing one of the RLS suite's accounts rather than creating
more. It creates a team and deletes it, and everything under it, at the end.

The assertion that matters most is that **the floor id the app minted is the
same id the row has in Postgres**. Ids are generated client-side and sent with
every insert; if Postgres generated its own instead, the cache and the database
would disagree about what each row is called and every later update would
address nothing. It is checked behaviourally — a second room added to the same
floor must land on that floor rather than creating a duplicate — because that is
the failure a user would actually see.

## `migrate-e2e.mjs` — the localStorage → Supabase import

```
node tests/migrate-e2e.mjs [email] [password]
```

Seeds a browser with data of the shape the app has always written, signs in,
runs the import from Settings, then checks the rows from outside the browser.
Same account and cleanup rules as `supabase-e2e.mjs`.

Three things it exists to protect:

- **Signing in must import nothing on its own.** The import writes into a shared
  team; it is opt-in, itemised and confirmed.
- **Malformed ids are reminted, not dropped.** This is the one path that reads
  data written by an older build on someone's actual laptop. Ids are remapped
  rather than replaced, because `visit.rooms` is keyed *by room id* — a new room
  id without rewriting that key would silently orphan every result on it.
- **Re-running creates no duplicates and says what it skipped.** A client
  already in the team is skipped by name before any insert is attempted.

## `rls.mjs` — the odd one out

Not a browser suite. It talks to Supabase directly with three real sessions and
asserts the Row-Level Security policies hold:

```
node tests/rls.mjs
```

It needs no dev server, but it does need `.env`. **This is the only way to test
RLS.** The SQL editor runs as a superuser with RLS bypassed, so every policy
looks like it works there whether or not it does.

Two preconditions, both in the Supabase dashboard:

- **"Confirm email" must be off** (Authentication → Sign In / Providers →
  Email). With it on, sign-up returns a user but no session, and the free
  tier's two-emails-per-hour limit stops the suite after the first account.
  Turn it back on before real users exist.
- **The addresses need a domain Supabase accepts.** `example.com` and
  invented domains are rejected outright as invalid. The suite uses
  plus-aliases on the project inbox, which resolve; with confirmation off
  nothing is ever actually delivered to them.

It deletes the teams it creates, and those cascade to every row beneath. The
`auth.users` rows survive — removing those needs the `service_role` key, which
deliberately is not in this repo. Clear them from the SQL editor:

```sql
delete from auth.users where email like '%+rls-%';
```

## Two things they've caught that unit tests wouldn't

- Rooms added on floor 2 landing on floor 1.
- A location's room list showing "Not started" after a completed visit,
  discarding what that visit found.

## What they can't catch

Anything that depends on a **native browser dialog**. `window.confirm` is
auto-dismissed in embedded panes, but Playwright can accept it programmatically
— so a native confirm passes here and silently fails for a real user. That is
why the app uses `ConfirmDialog` instead, and why interactive flows are worth
clicking through in the preview as well.

## Requirements

`playwright-core` (drives your installed Chrome, so no browser download) and
`exceljs` (reads the generated reports back). Both are devDependencies.
