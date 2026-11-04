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
| `custom-list.mjs` | the unbuilt gate, own template, own visit history | 18 |

`packs.mjs` is not a browser suite and needs no dev server: it imports the pack
registry (`src/data/packs/`) and `templateStore.js` straight into Node and holds
them to the catalogue in `supabase/migrations/` — every pack and workflow there
has an entry, the AV lists are the ones Pemcora shipped with, and every seed
becomes a template with only the fields step B2 defines, and each workflow's interval is the
catalogue's (38 checks).

```
node tests/packs.mjs
```

`template-types.mjs` is the same kind of suite, for step B2's test and section
types (`src/lib/testTypes.js`): what each answer type keeps and when it is a
fail, a template using every type round-tripping through the store, coverage
gaps, the report snapshot (`src/lib/reportSnapshot.js`) for a whole-site visit
with items and readings, whole-site fails reaching Home, and the Excel export —
including an AV visit, which must export exactly as before (72 checks).

```
node tests/template-types.mjs
```

## Offline and multiple devices

Three suites, from the rules up to the real thing. All three cover the five cases
step B3 asks for: a reload with unsaved changes, a dropped connection mid-visit, a
visit continued the next day, two devices on the same visit, a refused offline start.

| Suite | Runs against | Checks |
|---|---|---|
| `save-queue.mjs` | Node: the real cache and adapter, with a stand-in database that can lose connections on demand. Also classifies failures as the real Supabase client reports them | 241 |
| `offline.mjs` | A real browser and real device storage, through the real screens, with browser contexts as devices sharing the stand-in. Checks `api.js` against PostgREST's real answers. Every request off the machine is refused | 130 |
| `offline-e2e.mjs` | The live project. Not in `npm test` | |

`offline-open.mjs` is step B3b, opening with no signal. Only a production build has a
service worker, so it builds one under `node_modules/.cache` (not `dist/`) and serves it
itself, with a backend address that doesn't exist, so nothing can reach the live project.
It covers an expired login, working a whole visit and exporting its report with no
connection, a network that goes nowhere, signing out offline, a deploy getting through, and
how the app reads what a team has, and a new person going through the real gate (57 checks). The suite runs in `npm test`, or on its own with no dev server:

```
node tests/offline-open.mjs
```

`fake-server.mjs` is the stand-in. It keeps the database rules that matter to saving;
the rules themselves are proved against real Postgres in `docs/editions/test/`.

```
node tests/save-queue.mjs
node tests/offline.mjs
```

`offline-e2e.mjs` proves the stand-in told the truth: real Postgres, real triggers, two
real browser sessions on one account. **It writes to the live project.** It makes a team
of its own and deletes it at the end. It needs the dev server and a confirmed account:

```
node tests/offline-e2e.mjs <email> <password>
```

## What a team has

`entitlements.mjs` is step B4. It runs the rules and the store in Node, then the real screens
in a browser against the stand-in: pages hidden by pack, a landlord's own navigation, the usage
line, the upgrade sheet, the banners, and what happens after paying. A refusal has to be told
by its code, so it checks that a 402 saying anything gets the sheet and anything else saying
"upgrade" doesn't (187 checks). The Teams page and who to ask need a signed-in team, so
`fixtures/mount-plan-pages.jsx` puts them on the page with one, with real requests behind them.
Those checks need `VITE_SUPABASE_URL` in `.env` and are skipped without it.

```
node tests/entitlements.mjs
```

`offline-open.mjs` checks how `DataBoot` reads them in a production build, since test mode
never runs it: with a good login, with no signal, with no such function on the project, and
with an answer that never comes. `offline-e2e.mjs` checks the real `team_entitlements()`.

## Signing up

`signup.mjs` is step B5. The rules run in Node first: every row of the starter table in 2.3,
and what can be chosen yet. Then Team Setup, the Teams page's form and the "Your pack" card run
in a browser, both with everything open and as the live site has them, and the suite reads back
what they asked the server to create (136 checks). What the server does with it is in the SQL
suite, and `offline-open.mjs` walks a new person through the real gate in a production build,
including a team made with its answer lost.

```
node tests/signup.mjs
```

## The workflow page (Phase C)

`workflow-pages.mjs` is step C1c. In Node: every workflow's page, name and route come from
the pack registry, Home names a visit by its own workflow, a pack still marked proposed is
never assumed, and room types go only to a team whose packs have them. Then in a browser in
test mode, with a team's plan put on the page as DataBoot would: an AV team's screens are as
they were, a team holding the Queensland pack sees its pages, Resume lands on them, and a
room's type is saved from the floor plan editor and from Add room and switches on the sections
it names (35 checks).

```
node tests/workflow-pages.mjs
```

`answers.mjs` is step C1d. A Custom List built with one test of each type and suggested
wording, worked through in a browser: what each type records, a reading kept with its unit and
judged against its limits, a No or a low reading opening the note box, the suggestions and the
one that asks for a timeframe, finishing and exporting refused while a note still says
[timeframe], and the suggestions reworded in Settings, where an AV list shows none (37 checks).

```
node tests/answers.mjs
```

`site-step.mjs` is step C1e. The rules for coverage and items in Node, then a Queensland smoke
alarm inspection walked in a browser: the whole-site step from the room list, alarms added as
they're tested and pinned to their rooms, a bedroom left without one named, a failed alarm
asked why and told it has to be replaced, its fails on the room list and Home, the report, and
an AV visit unchanged (36 checks).

```
node tests/site-step.mjs
```

`signoff.mjs` is step C1f. A Queensland smoke alarm inspection finished by signing off, in a
browser: what the sign-off needs, what's kept with the visit, the report it exports (read back
with ExcelJS), a correction signed again, exporting an open check, and an AV visit finished and
exported as it always was (22 checks).

```
node tests/signoff.mjs
```

`equipment.mjs` is steps C2, C2b and C2d. The rules for item types and expiry dates, and the report's
equipment as the snapshot and the Excel export lay it out, in Node; then a Queensland
smoke alarm site in a browser: the equipment panel before any visit, alarms added and edited with
their own fields, a manufacture date filling in the expiry, expired and soon-to-expire alarms
flagged, a removed one kept under Removed, the whole-site step testing the alarms the panel
added, an alarm replaced from the panel and from a failed alarm's note, one removed, and no
panel on an AV page (69 checks).

```
node tests/equipment.mjs
```

`label-photo.mjs` is step C2c. A photo of a smoke alarm's label, in a browser that answers every
request off the machine itself, as the database and the photo bucket would: the photo made small
before it goes, its record first in the team's own folder and then the file, a failed upload
taking its record with it, the plan's refusal getting the upgrade sheet, no signal sending
nothing, and the Pro tag once the limits are on (26 checks). The photo checks need
`VITE_SUPABASE_URL` in `.env`, though nothing is sent there.

```
node tests/label-photo.mjs
```

`client-settings.mjs` is steps C3, C3b and C3c. The interval rules in Node, then a browser with
the team's packs put in place as the app reads them, answering every request off the machine
itself: an AV team's Settings with no licence numbers, a team doing electrical checks recording
the business's licence and REC numbers and the technician's own, the sign-off filling it in, the
report printing the business's, the team's reminders switch, a client's contact and reminders
switch on Edit Client, and how often checks are due for the team and for one client, refused,
offline, and never for one the law fixes (36 checks).

```
node tests/client-settings.mjs
```

`due.mjs` is steps C4 and C4b. The Due page's rules in Node, then the page in a browser
answering every request off the machine itself, as `due_list()` and `due_opt_outs()` would: the
list in its order, named and dated in words, filtered by client, each check's reminders switch
and a refusal, "no longer needed" from the opt-out list, the page before 0009 is applied, the
last list kept on the device without the contacts' emails and shown dated with no signal, and a
landlord's `/due` left as it was (33 checks).
`offline-open.mjs` checks that signing out removes the kept list.

```
node tests/due.mjs
```

`devices.mjs` is step C5b. Naming a device from its browser details and finding this device
in its own token, in Node; then the signed-in devices list put on the page by itself (it only
renders with a real login): this device first, signing one out and all the others after
asking, a refusal, the list before 0010 is applied and with no signal; and `api.js`'s calls
against the answers the database gives (27 checks). `devices-e2e.mjs` does it for real.

```
node tests/devices.mjs
```

## `supabase-e2e.mjs` — the only suite that runs on the real backend

Every suite above runs in test mode on localStorage. This one deliberately does
not: it signs in through the real gate, so the app runs on the Supabase adapter,
then drives the actual UI and checks the rows **from outside the browser** —
because "it still shows on screen" could just be the in-memory cache, and the
point is to prove the data reached Postgres.

```
node tests/supabase-e2e.mjs [email] [password]
```

Needs the dev server and a confirmed account with no team of its own: Team Setup asks
what its team does, and the suite answers AV integration. Sign-up is open on the project
with Confirm email on, so pass an account you've already confirmed. It creates a team
and deletes it, and everything under it, at the end.

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
