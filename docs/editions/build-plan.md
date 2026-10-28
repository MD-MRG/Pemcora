# Pemcora editions — build plan for Claude Code

**What this is.** The complete plan for turning Pemcora from an AV-only maintenance app into
one app sold as editions: AV maintenance, rental electrical and smoke alarm compliance for
electricians, and a side for landlords and agencies who receive the reports. It brings
together everything decided in planning, M.D.'s notes on each part (marked **M.D.'s
note** below), and the full pack test lists.

**Status.** Nothing in this plan is built yet. The database drafts in `docs/editions/`
(`0006_editions.sql`, `0007_compliance_and_reports.sql`) pass their 72-check SQL suite but
have **not** been applied to Supabase, so Phase A changes them in place rather than adding
new migrations on top.

**Read with.** `docs/editions/data-model.md` describes the drafted data model. Where it and
this plan differ, this plan wins.

**Confirmed.** M.D.'s note on electrician packs ends mid-sentence ("Also add steps to
design…"). M.D. confirmed it meant smoke alarm checks for the other states, which the state
packs in step G2 include.

---

## 0. How to work through this plan

- Work phase by phase, in order. Each step says what to change and how to know it's done.
- Keep the repo's conventions:
  - migrations are safe to re-run and end with a verification query (see 0001–0005)
  - Row-Level Security and table privileges are two separate locks; use both
  - `SECURITY DEFINER` only where a rule needs it
  - test lists live in code (`src/data/`), never in SQL
  - Preventative Maintenance, Commissioning and every new workflow share one
    `src/workflows/WorkflowPage.jsx`, configured per workflow; never copy it
  - HashRouter, React 19, Vite, Tailwind v4, ExcelJS as today
- Today's AV app must keep working after every step.
- Never apply a migration to the live Supabase project, deploy an Edge Function or change
  Stripe without M.D.'s go-ahead.
- The plan limits stay switched off (`app_settings.enforce_limits = false`) until step E6.
- After each step, run `npm run lint`, the affected `tests/*.mjs` suites and, when SQL
  changed, `docs/editions/test/run_tests.py`. Add tests for anything new.
- One commit per step, one pull request per phase.

### 0.1 Effort level for each phase

Claude Code starts Opus 5.5 at `medium` effort, and a top-level `effortLevel` in the user
settings file doesn't apply to Opus 5.5. Before each phase, run `/effort` and pick the level
below. Pressing Enter in the picker saves it as the Opus 5.5 default; pressing `s` applies
it to that session only. `max` applies to the current session only.

Higher levels test more edge cases and check more of their own work, but they're slower and
use more tokens. `max` can overthink, so keep it for review passes.

| Step | Effort | Why |
|---|---|---|
| A1–A3b database drafts and their tests | `xhigh` | security rules, races and billing state; mistakes are hard to undo once applied |
| Before A4 and before E6 | `max`, in a fresh session | a separate review that looks only for security holes, before the migrations go live and before the limits are switched on |
| B1 pack files, B5 sign-up | `medium` | clear scope: moving lists and building one screen |
| B2 template schema, B4 entitlements | `high` | existing AV data and every error path must keep working |
| B3 offline and multiple devices | `xhigh` | the hardest app change; a mistake here loses field data |
| C1 workflow page | `high` | shared by every workflow, including today's AV visits |
| C2–C4 equipment, settings, Due page | `medium` | screens on top of finished database functions |
| D1 PDF builder | `medium` | mostly layout |
| D2–D3 sending, report links and saving | `xhigh` | public links, short-lived file links and the email check protect landlords' data |
| D4 landlord side | `medium` | screens on top of finished functions |
| E1–E5 billing | `xhigh` | money, and webhooks that can arrive late, twice or out of order |
| F reminders | `high` | one email per cycle, working opt-out links, no duplicates |
| G state packs | `high` | the research must be accurate; a licensed electrician still checks every list |
| H tests and docs | `high` for `tests/rls.mjs`, `medium` for docs | |

---

## 1. Context and priorities

- **Who it's for.** Providers do inspections: AV integrators and electricians. Landlords
  and agencies receive reports and track what each property owes.
- **Why now.** From 13 October 2026, every Victorian rental needs an electrical and gas
  safety check every 2 years, and since 25 November 2025 a smoke alarm check every 12
  months. Every Queensland home must meet the new smoke alarm rules by 1 January 2027.
- **Growth loop.** Every report an electrician sends brings a landlord into Pemcora, so
  sending reports stays free on every plan.
- **Optional fast track.** The Queensland smoke alarm pack needs the fewest new app
  features. Building it first is a bonus for the 1 January 2027 deadline, not a
  requirement.
- **Stack today.** React app on GitHub Pages, Supabase (Postgres, Auth, Storage, Edge
  Functions), Resend for email (`supabase/functions/send-invite`). Stripe is new.

### Decisions already made

| Decision | Detail |
|---|---|
| One app, sold as editions | Packs per trade and state, not separate apps |
| Free plan | 1 seat, 1 inspection a month, the starter pack, no photos |
| Pro plan | paid seats, unlimited inspections, add-on packs, photos, logo on reports, re-check reminders |
| Sending reports | free on both plans |
| Where limits live | in the database, because the app's key is public; the app only explains them |
| Limits at launch | shipped switched off; they count but refuse nothing until billing is live |
| Existing teams | Pro free of charge with the AV pack, permanently ("comped") |
| Card declined | 7 days to pay, then the team moves to Free (M.D.'s note) |
| Cancelling | Pro until the end of the paid period (M.D.'s note) |
| Report links | public view for 90 days; saving to an account never expires |

---

## 2. Product rules

This section is the specification. Phase A to H implement it.

### 2.1 Packs and workflows

Every visit belongs to one workflow (that's what `visits.kind` is), and every workflow
belongs to one pack. When someone starts a visit, the database checks the team holds the
pack that workflow belongs to.

Packs decide which kinds of inspection a team can do. The plan, Free or Pro, decides how
much: seats, inspections a month and photos. Adding another state later means adding its
pack and workflows to the catalogue and its test lists to the app, with no changes to the
database tables.

| Pack | Workflows | Repeats every | Who gets it |
|---|---|---|---|
| `core` | `custom` | — | every team |
| `av` | `maintenance`, `commissioning` | set by the team or per client (2.8) | AV integrators |
| `vic_rental` | `vic_electrical_safety`, `vic_smoke_alarm` | 24 and 12 months, fixed by law | electricians in Victoria |
| `qld_electrical` (renamed from `qld_smoke`) | `qld_smoke_alarm`, `qld_electrical_safety` (new) | 12 months fixed; 24 months default, adjustable | electricians in Queensland |
| `electrical_general` (new) | `electrical_safety`, `smoke_alarm_check` | 24 and 12 months default, adjustable | electricians in states without their own pack yet |
| one per remaining state (G2) | to design | to research | electricians in that state |

- A workflow whose interval is set by law is marked `interval_fixed`; teams can't change it.
- Every electrician pack has the same shape as `vic_rental`: an electrical safety check and
  a smoke alarm check, with state rules where they exist (M.D.'s note).

### 2.2 Visits continue across days and dropped connections

> **M.D.'s note:** when a visit is not finished in one day or the internet connection
> drops, the visit needs to be able to continue afterwards and the data entered needs to
> remain. Same as in Pemcora.

- An open visit stays open until it's completed, on any day and any device, as in Pemcora
  today.
- A visit is counted once, when it's first saved to the database. Continuing, editing or
  finishing it later is never counted or refused, even after the allowance is used up or
  the plan changes.
- Reopening a finished visit is for corrections: completing it again keeps the date it was
  first completed, so its report and due dates stay as they were. A new inspection of the
  same site is a new visit, and counts. (Decided after the Phase A security review.)
- Anything entered survives a dropped connection, a closed app or a reload. Unsaved
  changes are kept on the device and sent when the connection returns.
- A visit started offline is checked when the device reconnects. If it's refused, it stays
  on the device marked "Not saved" and saves once the team upgrades. It never stops other
  changes from saving.

### 2.3 Getting and switching packs

| How | Who sets it | Example |
|---|---|---|
| `core` | every team, automatically | custom lists |
| Starter pack, one per team | owner or admin, at sign-up | an electrician in Victoria gets `vic_rental` |
| Add-on | the billing webhook, once paid | an AV firm adds `vic_rental` |
| Granted free (`comped`) | M.D., in the SQL editor | the existing team's `av` |

**Sign-up.** The sign-up screen asks what the team does and which state it's in, then picks
the matching starter pack:

| Team does | State | Starter pack |
|---|---|---|
| AV integration | any | `av` |
| Electrical work | Victoria | `vic_rental` |
| Electrical work | Queensland | `qld_electrical` |
| Electrical work | any other | `electrical_general`, until that state's pack exists |
| Landlord or property management | any | no pack (they receive reports) |

> **M.D.'s note:** when the matching pack is allocated, the team confirms the selection.
> The option to add another pack as an add-on is shown at the same time, with a "no
> add-on" option and a message saying add-ons can be added any time.

So after the questions, one confirmation screen shows:

- the matched starter pack, with a way to change it if the match is wrong
- the other packs as optional add-ons, with prices
- a "No add-on" choice, selected by default
- the line "You can add packs any time."

Choosing an add-on goes to checkout (add-ons come with Pro; decision D2).

**Switching.**

- The starter pack can be swapped until the team has started any visit under it. After
  that it's fixed, and getting another kind of inspection means adding a pack; otherwise a
  free account could switch packs every month and use them all for free.
- When a state's own pack is released, give it free to that state's teams on
  `electrical_general`.
- Losing an add-on only stops new visits of that kind. Past visits, sent reports and due
  dates all stay, and the app keeps them viewable even though it hides that pack's pages.
- A team's type (provider, landlord or agency) is fixed when it's created. Someone who does
  both, such as an electrician who owns rentals, has one team of each kind.
- A new inspecting team never silently gets AV. The new sign-up always passes a pack; only
  today's `create_team()` keeps the AV fallback, until the new sign-up replaces it.

### 2.4 Plans

| | Free | Pro | Enforced by |
|---|---|---|---|
| People in the team | 1 (just the owner) | the seats paid for, or unlimited | the database, when someone joins, accepts an invite or is moved in, and when an invite is sent |
| Inspections a month | 1 | unlimited | the database, when a visit is saved for the first time |
| Packs | the starter pack | starter plus paid add-ons | the database, when a visit is started |
| Photo evidence | no | yes | the database, on upload and on the photo record |
| Your logo on reports | no | yes | the app, until reports are made on the server |
| Re-check reminder emails | no | yes | the daily reminder job |
| Sending reports to landlords | yes | yes | not limited |

A team counts as Pro when its plan is Pro and its status is active, trialing, or past due
for less than 7 days. A cancelled team, or one with no plan record, is treated as Free.

### 2.5 Monthly inspection allowance

- Each team has a counter per calendar month, Sydney time. It resets at midnight on the
  1st.
- A visit counts once, when it's first saved to the database. A refused attempt uses
  nothing. Deleting a visit doesn't give the inspection back.
- Counting uses the server's clock, not the start date the device sends (see 2.12).
- Each team's Free allowance is stored on its plan record, so one team can be given more
  (say 5 as a launch offer) or unlimited.

> **M.D.'s note:** if one device starts a visit, another device can start the same visit,
> but the other device can't start a different visit once the allowance is reached.

- Same site, same check, already open: the second device joins the open visit and nothing
  more is counted, even when the allowance is used up.
- Anything else once the allowance is used up: refused.
- Verified on a local copy of the drafts: as written, the draft refuses the second device
  instead of letting it join. Step A1 fixes this.

Open decision D3: a Victorian electrical check and smoke alarm check at the same house on
the same day currently count as 2 inspections.

### 2.6 Billing lifecycle

- **Trial.** Counts as Pro.

> **M.D.'s note:** when a card is declined, payment needs to be made within 7 days; if not,
> the plan moves to Free.

- **Card declined.** The team stays Pro for 7 days from the first failed payment. The app
  shows a banner with the deadline and a link to update the card, and admins get emails on
  days 0, 3 and 6. After 7 days the database treats the team as Free, even if Stripe
  hasn't caught up yet. A successful payment ends it.

> **M.D.'s note:** when the subscription is cancelled, all started visits need to be
> finished before the start of the new billing cycle.

- **Cancelling.** Cancellation always takes effect at the end of the paid period. Until
  then the team stays Pro, and the app shows "Pro ends on 15 November. Finish these open
  visits before then:" with the list of open visits. Admins get emails 7 days and 1 day
  before. After the period ends, Free limits apply to new actions; visits still open stay
  editable so no work is lost (decision D4).
- **Downgrading deletes nothing.** Extra members stay, but nobody new can join. Old photos
  stay, but new ones are refused. The team drops back to 1 inspection a month. The database
  won't remove paid add-on packs when they're cancelled, so the billing webhook does it
  (step E2, M.D.'s note).

### 2.7 Seats and invitations

- Invitations that haven't been accepted count as taken seats, so a full team can't send
  more. The admin sees "team is full" when trying to invite.

> **M.D.'s note:** if two people go for the last seat at the same moment, only one gets it,
> and the admin gets a message like "invite was cancelled, all seats are taken". The
> message needs to include the name of the person who was invited but didn't get the seat.

- This can happen when the seat count is lowered after invitations went out, or when
  someone joins with the team code while an invitation is still open.
- The person who misses out sees "This team is full. Ask the person who invited you."
- Their invitation is cancelled, and every owner and admin gets a notice in the app and by
  email: "The invitation for Jane Smith (jane@example.com) was cancelled because all seats
  are taken."
- Invitations gain an optional name field so the notice can name the person. Without it,
  the notice uses the email address.

### 2.8 Due dates, regular PM visits and reminders

**Due dates move on by themselves.**

- The first time a recurring check is completed at a site, the database adds it to that
  site's list. Each later completion moves the due date on from the day the work was done.
- Dates never move backwards: finishing an older visit late can't pull a newer due date
  back. Dates are Sydney dates.
- Each side keeps its own copy. The electrician's copy is their re-check list. The
  landlord's copy is their compliance tracker, and it moves on whenever a report is filed
  under that property, whichever electrician sent it.

**Regular PM visits for AV.**

> **M.D.'s note:** add an option to set a regular PM visit time frame for each client, and
> another to set a default time frame for all clients in the AV pack. If the default is
> set, setting a time frame for an individual client overrides it for that client only.

- AV settings get "Regular PM visit: every N months" as the team default for all clients.
- Each client gets "PM visits every N months" or "Use team default". A client's setting
  overrides the default for that client only.
- The interval applies to all of that client's sites. Changing it recalculates their due
  dates from the last PM visit.
- A site with no PM visit yet shows as "Not done yet" until the first one (decision D7).
- The same settings work for any workflow whose interval isn't fixed by law, such as
  `electrical_general`.

**Hand-entered checks.** When a landlord records a check by hand, such as a gas check, the
database works out the next due date, just as it does for visits and delivered reports.

**Expiring alarms.** The Due page and reminder emails also list smoke alarms expiring in the
next 3 months (adjustable), not just checks coming due.

**Reminders.**

> **M.D.'s note:** write a plan for reminders and add an option to turn them off.

- Once a day, a scheduled job finds checks coming due within each item's reminder window
  (30 days by default) for teams on Pro.
- It emails the client's contact a "Book your re-check" message with the electrician's
  contact details, listing what's due at that site and any alarms expiring there.
- It records when each reminder went out, so a client gets one per cycle. Completing the
  next visit resets it for the following cycle.
- Reminders can be turned off for the whole team (Settings), for one client (client page)
  and for one check (Due page). All default to on.
- Every email has a "No longer needed" link. Clicking it stops reminders for that check and
  tells the electrician, for example "Jane says the check at 10 Smith St is no longer
  needed." This covers a landlord who switches electricians.
- Once a client has switched reminders off with that link, the team can't switch them back
  on: an unsubscribe has to stick (Spam Act 2003). (Decided after the Phase A security
  review.)

### 2.9 Equipment register

- `assets` holds one row per physical item at a site: smoke alarms, RCDs, switchboards, and
  for AV displays or codecs. Items belong to the site, so they carry over between visits.
- Type-specific details live in `attributes`, defined by the pack. A replaced item is
  marked removed, not deleted.

> **M.D.'s note (yes, put it in the plan):** link test results to individual items.

- A template section can repeat for every item of one type at the site, such as each RCD
  or each smoke alarm, and each item's results are saved under that item. This needs
  template and app changes only, not new tables. The stored shape is in step A2.

### 2.10 Reports

**Sending.** The electrician taps Send on a finished visit. The app makes the PDF in the
browser and uploads it to the team's private report folder, where it can't be replaced or
deleted. A server function records the delivery and emails the landlord a private link. The
database fills in the site address and the electrician's business name itself, so neither
can be faked. Free accounts can send reports.

**The frozen copy.** A sent report is a record in `report_deliveries` plus the PDF. Once
sent, nobody can edit the record, and the PDF can't be replaced or deleted. Editing or
deleting the visit later changes neither. Only bookkeeping changes afterwards: when it was
first opened, who saved it and which property it's filed under.

- Filled in by the database: which check, the completion date, the declared outcome, the
  site address, the business name and company details, the technician's sign-off, who sent
  it, when, and the recipient's email.
- Written by the app (the snapshot): the client, the technician, visit start and completion
  dates; each room with its floor, the test list as used, every result and only the
  sections switched on; notes on failed tests and comments; whole-site results; readings
  with units; the equipment list as it stood that day; and a revision number when it
  corrects an earlier report.
- The PDF: the readable version of the same content, with the electrician's logo on Pro.

> **M.D.'s note (yes, put it in the plan):** photos and licence numbers.

- **Photos** are embedded in the PDF, resized. Landlords can't open the electrician's
  private photo folder, so the PDF is the only way photos reach them.
- **Licence numbers.** The business's licence and REC numbers go in the company details,
  and each technician's licence number in their own settings. Both print on reports.
  Consumer Affairs Victoria requires the electrician's name and licence or registration
  number on the electrical safety check record.
- **Sign-off.** The technician's name, licence number and signature are captured at
  sign-off and stored with the visit, so later changes to settings don't rewrite it. The
  database adds who was signed in and when it was saved.

**Reading, saving and filing.**

- Only the address a report was sent to can save it, by signing up or signing in with that
  email.
- Pemcora looks for a property in that account with the same street address and suburb.
  If one matches, the report is filed there and the property's due date moves on.
  Otherwise it arrives unfiled, and the landlord picks the property or creates it from the
  report's address.
- Filing links the electrician's site to the landlord's property, so the next report for
  that site files itself when it goes to anyone in that landlord's account. The landlord
  can remove the link.
- A report sent to the wrong address can be withdrawn until it's saved. A report that files
  itself counts as saved straight away, so a mistake there is fixed by sending a corrected
  report.

> **M.D.'s note (yes, put it in the plan):** report link expiry.

- Viewing without an account works for 90 days. After that, the link says it has expired
  and names the electrician to ask for a new one.
- Once the landlord saves the report, the link asks them to sign in. They can still
  download the PDF to pass on, for example to a renter.
- Saving never expires, because it needs a sign-in with the right email.
- The report itself never expires; only the public view through the link does.
- The electrician gets a "Send again" button, which sends a fresh link and switches off the
  old one.
- The PDF is only ever served through links that last a few minutes.

### 2.11 When a limit refuses something

- **Show the allowance before it runs out.** Visit pages show "1 of 1 free inspection used
  this month · resets 1 Nov". Once it's used, the Start button becomes "Upgrade to start",
  so most refusals never reach the database.
- **Refusals get an upgrade sheet, not an error.** The sheet says plainly what happened,
  when the free inspection comes back, and what Pro adds (unlimited inspections, photos,
  your logo, re-check reminders). It has "Upgrade to Pro" and "Not now" buttons and the
  line "Anything you've entered is kept and saves once you upgrade."
- **Recognise refusals by their code.** HTTP 402 with the hint `upgrade` gets the sheet.
  Anything else gets the usual "Save failed" message. Never parse message text.
- Only owners and admins see "Upgrade to Pro". Others see who to ask.
- After payment, refresh the entitlements, save anything waiting, and confirm with "You're
  on Pro. Your visit is saved."
- A missing pack should rarely come up, because pages for packs a team doesn't hold are
  hidden. If it does, the sheet names the pack and offers to add it, or to swap the starter
  pack if the team hasn't used it yet.
- The same sheet, with different wording, covers a full team when inviting someone and
  photos on Free.

### 2.12 The backdating loophole

> **M.D.'s note:** explain further if and how a user could actually do it.

**How it could be done.** Pemcora's database key is built into the app, and each signed-in
user's login token is stored in their browser. Someone with programming skills could use
the browser's developer tools, or a short script with the Supabase library, to sign in as
themselves and create a visit directly in the database with a start date in last month. The
draft counts a visit only if its start date falls in the current month, which is how old
work imported from before an account existed is left out. So that visit wouldn't be
counted, and repeating it gives unlimited free inspections. The same trick could put false
completion dates on compliance reports, which matters more for a compliance product than
the lost revenue.

**What it takes and what it can't do.** It needs deliberate effort and technical knowledge;
the app itself never does it. It only affects the person's own team, because Row-Level
Security still blocks every other team. It can't get around packs, seats, photos or the
plan, which the database checks regardless of dates.

**The fix (step A1).**

- Count by the server's clock at the moment the visit is saved, so the start date no
  longer affects counting.
- Refuse start and completion dates more than 7 days in the past (long enough for a device
  that was offline) or in the future.
- Allow old work to be imported only through a one-time import window: owner-only, once per
  team, 15 minutes long. Work completed in the last 7 days still counts inside the window,
  whatever start date it claims. (Decided after the Phase A security re-check.)

---

## 3. Pack test lists

`core` and `av` are the lists in the app today (`src/data/testLists.js`). The others are
proposals built from the official forms and rules. A licensed electrician must check each
one before it ships.

Unless noted, every test records PASS, FAIL or N/A. A failed test takes a troubleshooting
note, and each room takes a comment.

### 3.1 `core` — Custom list

- Workflow `custom`. Every team has it. No repeat interval.
- Starts empty. The technician adds tests to the main list and creates their own named
  sections, for jobs the standard lists don't cover.

### 3.2 `av` — AV maintenance and commissioning

Workflows `maintenance` and `commissioning`. Repeat set by the team or per client (2.8).
Each room has a main list plus two optional sections, switched on per room (defaulting to
the previous room's choice).

**Preventative maintenance — main list (19)**

1. Correct Time and Date
2. Room Wake On Touch
3. Test call performed
4. Audio In room
5. Video In room
6. Audio to Remote participants
7. Video to Remote participants
8. Content video In room
9. Content video Remote participants
10. Content audio In room
11. Content audio Remote participants
12. Video quality
13. Audio quality
14. Cameras working as specified
15. Hearing Augmentation
16. TV Remote available
17. FW updated
18. Booking panel signed in with calendar displayed
19. BYOD

**Commissioning — main list (25).** The same 19 tests in a different order, plus six setup
checks:

- Test network connectivity to all AV devices
- Display image calibration and scaling
- Audio DSP routing and tuning
- Teams room account signed in
- Touch panel functionality check
- TV Volume turned down

**Room controls (9, both workflows):** Room ON/OFF · Source selection · Speaker Volume ·
Speaker Mute · Mic Volume · Mic Mute · Ceiling Mic LED Mute Sync · Camera Control · Camera
Presets

**Additional AV Sources (5, both workflows):** Signage · Apple TV · Foxtel · FTA STB · Sonos

### 3.3 `vic_rental` — Victorian rental safety checks (proposed)

**Electrical safety check (`vic_electrical_safety`, every 24 months, fixed).** Mirror
Energy Safe Victoria's report form (ESV-RTR-ESC 01.1) section for section, so the PDF looks
like the report Victorian electricians and agents already know. Consumer Affairs Victoria
requires the check to follow section 4 of AS/NZS 3019, and the record to show the
electrician's name and licence or registration number, the date, and the results including
repairs and actions taken. Most of it is one checklist for the whole property, not room by
room.

| Section | Tests | Recorded as |
|---|---|---|
| A. Installation | address; date of previous check | filled in from Pemcora's records |
| B. Extent of installation | main switchboard, main earthing system, kitchen, main bathroom, other bathrooms and ensuites, main bedroom, other bedrooms, living room, other living areas, laundry, garage, solar or battery system, electric water heater, dishwasher, electric room or space heaters, swimming pool equipment | included / not applicable / not included; pre-filled from the site's rooms |
| C. Visual inspection (20) | consumers mains, switchboards, exposed earth electrode, metallic water pipe bond, RCDs (safety switches), circuit protection (circuit breakers and fuses), socket-outlets, light fittings, installation wiring, electric water heater, air conditioners, space heaters, cooking equipment, dishwasher, exhaust fans, ceiling fans, washing machine or dryer, solar and other renewable systems, swimming pool equipment, vehicle chargers | checked / not applicable / not included |
| D1. Polarity and correct connections (12) | consumers mains, circuit protection, RCDs, socket-outlets, light fittings, electric water heater, air conditioners, cooking equipment, dishwasher, solar and other renewable systems, swimming pool equipment, vehicle chargers | checked / not applicable / not included |
| D2. Earth continuity (14) | mains earth conductor, switchboard enclosure, metallic water pipe bond, socket-outlets, light fittings, exhaust fans, ceiling fans, electric water heater, air conditioners, cooking equipment, dishwasher, solar and other renewable systems, swimming pool equipment, vehicle chargers | reading in ohms, or a note such as double insulated |
| D3. RCD testing (one row per RCD, repeated per item) | circuit protected, push-button test, time test, trip time | pass/fail; trip time in milliseconds |
| E. Smoke alarms | all correctly installed, working and tested to the manufacturer's instructions; next smoke alarm check due | yes/no; date filled in from the smoke alarm check |
| F. Observations and recommendations | each defect and what was done (repaired, replaced, retested) | text |
| Certification | electrician and business name, REC number, licence or registration number, inspection date, next check due, declaration, signature | from sign-off and Settings |

ESV's form dates from 2021 and cites the 2007 edition of AS/NZS 3019, while Consumer Affairs
Victoria now uses the standard's newer title ("Periodic assessment"). Check the form is
still current before copying it.

**Smoke alarm safety check (`vic_smoke_alarm`, every 12 months, fixed).** Required for all
Victorian rentals since 25 November 2025.

For each alarm (repeated per item):

- Marked AS 3786
- Correctly installed
- Works when tested to the manufacturer's instructions
- Battery fitted and replaced where needed (a removable 9 V battery replaced every year)
- Hard-wired with a backup battery, if the building dates from after 1 August 1997
- Interconnected, if built after 1 May 2014 and more than one alarm is required
- Under 10 years old (fire services advise replacing alarms after 10 years)

For the whole property:

- At least one alarm on each level
- An alarm between each sleeping area and the rest of the house
- Renter given written information on how each alarm works and how to test it (the
  landlord's duty at the start of a tenancy; optional)
- Next check due date

### 3.4 `qld_electrical` — Queensland electrical and smoke alarm compliance (proposed)

**Smoke alarm compliance inspection (`qld_smoke_alarm`, every 12 months, fixed).** Rentals
also need it within 30 days before each lease starts or renews. All Queensland homes must
comply from 1 January 2027. The report doubles as the compliance certificate agents and
sellers ask for (sellers still lodge their own Form 24).

For each alarm (repeated per item):

- Photoelectric, marked AS 3786-2014
- No ionisation sensor
- Under 10 years old (manufacture date on the alarm)
- Hard-wired with a backup battery, or a sealed 10-year battery (a hard-wired alarm can
  only be replaced with another hard-wired one)
- Interconnected with every other alarm
- On the ceiling where practicable
- At least 300 mm from a wall-ceiling corner
- At least 300 mm from a light fitting
- At least 400 mm from an air-conditioning vent
- At least 400 mm from ceiling-fan blades
- Works when tested (replaced immediately if not)
- Cleaned

For each storey:

- An alarm in every bedroom
- An alarm in hallways connecting bedrooms to the rest of the dwelling, or between the
  bedrooms and the rest of the storey if there's no hallway
- On a storey without bedrooms, an alarm in the most likely path out of the dwelling
- All alarms sound together when one is set off
- Stairways, sloping ceilings and exposed beams placed as the Building Fire Safety
  Regulation 2008 requires

**Electrical safety check (`qld_electrical_safety`, every 24 months by default,
adjustable).** Starts with the `electrical_general` electrical safety check list (3.5).
Step G2 researches Queensland's own rules, such as safety switch requirements for rentals,
and adds them.

### 3.5 `electrical_general` — Electrical compliance baseline (proposed)

For electricians in states without their own pack yet. A baseline only: each state's own
rules replace it in step G2.

**Electrical safety check (`electrical_safety`, every 24 months by default, adjustable).**
The same sections and tests as the Victorian check in 3.3 (A to F and certification),
following AS/NZS 3019 periodic assessment, without the Victorian form's references.

**Smoke alarm check (`smoke_alarm_check`, every 12 months by default, adjustable).**

For each alarm (repeated per item):

- Marked AS 3786
- Correctly installed
- Works when tested to the manufacturer's instructions
- Battery fitted and replaced where needed
- Interconnected where required
- Under 10 years old

For the whole dwelling:

- At least one alarm on each storey
- Alarms between the bedrooms and the rest of the dwelling, and in hallways serving
  bedrooms, as the National Construction Code requires
- Next check due date

### 3.6 What the new packs need from the app

1. More answer types than PASS/FAIL/N/A: "not included", yes/no, and readings in ohms and
   milliseconds.
2. Sections repeated for each RCD and each smoke alarm, with results stored per item.
3. Sections that cover the whole property, since the electrical checks are mostly one
   checklist.
4. Coverage checks by room type, for "an alarm in every bedroom".
5. The electrician's licence or registration number and REC number, and a signature at
   sign-off.
6. Pre-filled details: the address, the previous check date and the next due dates all
   come from Pemcora's own records.
7. Queensland rentals are due within 30 days before each lease starts or renews. Pemcora
   doesn't store lease dates, so the 12-month repeat stands in for them (decision D10).

---

## 4. Build plan

### Phase A — Database (change the drafts before anything is applied)

#### A1. Amend `0006_editions.sql`

1. **Let a second device join an open visit.** Split `gate_visit_start()` into two
   triggers:
   - `gate_visit_pack()`, before insert: the pack check and the date checks in item 2
   - `count_visit_start()`, after insert: the monthly counter and the allowance check

   Because the counter now runs after the insert, the one-open-visit-per-site-and-check
   rule (`visits_one_open_per_kind_idx`) answers first. A second device starting the same
   visit gets a duplicate error (23505), and the app's `startVisit()` already turns that
   into "join the open visit". A different visit is still refused with 402. This was
   prototyped against the drafts and behaves exactly this way.
2. **Close the backdating loophole (2.12).**
   - Count every visit in the month of `now()` (Sydney), whatever `started_at` says.
   - Refuse `started_at` or `completed_at` more than 7 days before `now()`, or more than 1
     hour after it. Apply this when the row is inserted and when `completed_at` is first
     set.
   - Add `teams.import_open_until` and `teams.import_used_at`. Add
     `open_import_window(p_team_id)`: owner only, once per team, opens a 15-minute window.
     Inside the window, visits started in earlier months aren't counted and the date checks
     don't apply.
   - Update `src/lib/migrate.js` to open the window before importing, and to say so when an
     import has already been used.
3. **7-day payment grace.** Add `subscriptions.past_due_since timestamptz`. `team_is_pro()`
   treats `past_due` as Pro only while `now() < past_due_since + 7 days`.
4. **Pro until the end of the paid period.** Add `subscriptions.cancel_at timestamptz`.
   `team_is_pro()` returns false once `cancel_at` has passed, even if the webhook is late.
5. **Fixed and adjustable intervals.** Add `workflows.interval_fixed boolean not null
   default false`, true for `vic_electrical_safety`, `vic_smoke_alarm` and
   `qld_smoke_alarm`.
6. **Catalogue changes.**
   - Rename pack `qld_smoke` to `qld_electrical`, labelled "Queensland electrical and smoke
     alarm compliance", and add workflow `qld_electrical_safety` (24, not fixed).
   - Add pack `electrical_general` with workflows `electrical_safety` (24, not fixed) and
     `smoke_alarm_check` (12, not fixed).
   - Update the SQL tests and `data-model.md` for the rename.
7. **No silent AV.** `create_organisation()` refuses a provider team without a pack. The
   AV fallback stays only in `provision_team()`, for teams made by today's `create_team()`.
8. **Seat races (2.7).**
   - Add to `team_invites`: `invitee_name text not null default ''`, `cancelled_at
     timestamptz`, `cancel_reason text`. Give `create_invite()` an optional name argument.
   - Add table `team_notices (id, team_id, kind, payload jsonb, created_at, read_at)`.
     Owners and admins can read it and mark notices read. Nobody can write it directly;
     only functions and the billing webhook do.
   - One shared path for `join_team()`, `accept_invite()` and `consume_invite_on_confirm()`
     checks for a free seat with the plan row locked. If the team is full, it cancels the
     invitation (reason `no_seats`) and adds an `invite_cancelled_no_seats` notice naming
     the person.
   - `accept_invite()` and `join_team()` return a "team is full" result instead of raising
     an error, because raising would undo the cancellation and the notice. The
     confirmation trigger still never raises (0005's rule). `invite_preview()` reports
     cancelled invitations. `gate_team_seats()` stays as the last line of defence.
9. **Entitlements.** `team_entitlements()` also returns `past_due_until`, `cancel_at`,
   whether the team has used its import window, and the number of open visits (for the
   plan-ending banner).

#### A2. Amend `0007_compliance_and_reports.sql`

1. **Per-item results (no table change).** Document and use this shape:
   - ordinary sections: `results[sectionId][testId]`, as today
   - sections repeated per item, in a room: `visit_rooms.results[sectionId][assetId][testId]`
   - sections repeated per item, for the whole site:
     `visits.site_results.results[sectionId][assetId][testId]`
   - readings follow the same paths, with `{ value, unit }`
   - the template snapshot records each section's scope, so readers know which shape
     applies
2. **Due list.** Add `due_list(p_team_id, p_within_days default 60, p_expiry_months default
   3)`, for members only. It returns checks overdue or due within the window, sites with a
   regular interval but no visit yet ("not done yet"), and alarms with `expires_on` inside
   the expiry window (`removed_at is null`), each with client and site details. Add
   `assets.expiry_reminded_at`.
3. **Reminder switches.**
   - `team_settings.reminders_enabled` (admins), `clients.reminders_enabled`, and
     `compliance_items.reminders_enabled`, all default true
   - `compliance_items.reminder_token uuid unique default gen_random_uuid()`,
     `opted_out_at`, `opted_out_via`
   - `reminder_opt_out(p_token)`, callable without signing in: switches that item's
     reminders off, adds a `reminder_opt_out` notice for the provider, and returns only the
     provider name and site address for the confirmation page
4. **Regular intervals (2.8).**
   - Add table `workflow_intervals (id, team_id, workflow_id, client_id null,
     interval_months, updated_at)`, with one partial unique index for the team default
     (`client_id is null`) and one per client.
   - Members can read it. Admins write it only through `set_workflow_interval(p_team_id,
     p_workflow_id, p_client_id, p_months)`, which refuses fixed workflows.
   - `effective_interval(team, workflow, location)` is the client override, else the team
     default, else the workflow default.
   - `set_workflow_interval()` creates or updates items for every site in scope, sets
     `next_due_on` from the last completed visit of that workflow (null if there's none),
     and deactivates items when the interval is removed.
   - `advance_compliance()` uses `effective_interval()`, so new sites get an item on their
     first completed visit.
5. **Hand-entered checks.** Add a before insert or update trigger on `compliance_items`.
   When `last_done_on` is set or changes and `next_due_on` wasn't changed in the same
   write, set `next_due_on = last_done_on + interval_months` and clear `last_reminded_at`.
   Do the same when `interval_months` changes. `advance_compliance()` and
   `_file_delivery()` set both dates themselves, so they're unaffected.
6. **Report link expiry.**
   - Add `report_deliveries.link_expires_at timestamptz not null default now() + interval
     '90 days'`.
   - `report_preview()` gains a `status` column: `ok`, `expired` or `saved`. It returns
     content only for `ok`, and just the provider name for `expired`.
   - Add `resend_report(p_delivery_id)` for the sending team: it issues a new token, resets
     the expiry, and returns the row for the Edge Function to email.
   - `claim_report()` is unchanged and still works after expiry.
7. **Licence numbers and sign-off.**
   - Add `member_prefs.licence_number text not null default ''`.
   - The company details (`team_settings.company`) gain `licence_number` and `rec_number`
     in the app; they're JSON, so no column change.
   - Add `visits.signoff jsonb`: `{ technician, licence_number, signed_at, signature }`,
     where the signature is an SVG path under 50 KB. It's stored with the visit, so it
     works on Free, unlike the Pro-only photo folder.
   - `send_report()` copies `signoff` from the visit row into the database-filled part of
     the report.

#### A3. Extend the SQL tests

Add checks to `docs/editions/test/run_tests.py` for:

- the second device joining an open visit after the allowance is used, and a different
  visit being refused
- counting by server time; dates outside the 7-day window refused; the import window
  (owner only, once, 15 minutes, history not counted)
- the 7-day grace (Pro on day 6, Free on day 8) and `cancel_at`
- the catalogue rename and new packs; `create_organisation()` refusing a provider with no
  pack
- seat races: cancelled invitation, notice naming the person, "team is full" result
- `due_list()` including expiring alarms and "not done yet" sites
- the reminder switches and `reminder_opt_out()`
- `workflow_intervals`: team default, client override, fixed workflows refused, due dates
  recalculated
- hand-entered checks getting a next due date
- link expiry states, `resend_report()` switching off the old token, saving after expiry
- `signoff` reaching the delivered report

#### A3b. Fixes from the security re-check

The pre-A4 security review's findings, and the review notes M.D. decided, are fixed in commit
`41f7cc7`. A re-check of that commit found seven defects in what it added (R1–R7), and
checking the re-check turned up two more cases (items 8 and 9 below, and the second half of
item 2). Fix them all in the two drafts.

1. **The 7-day window for correcting a completion date must not slide** (R1). It runs from the
   current completion date, so correcting the date every six days keeps it open for good, and
   one visit can be sent again as a fresh inspection without being counted. Add
   `visits.completion_recorded_at`, set by the database when the visit is first completed and
   never by the client. Measure the 7 days from it, or from the completion date if that is
   earlier.
2. **A client's emailed opt-out must outlive the check's row** (R2). Deleting the check and
   adding it back, or the next completed visit adding it back, turns reminders on again. Keep
   opt-outs in a table only `reminder_opt_out()` writes, and have every new check row take its
   opt-out from there. Key that table on the team, the recipient's email address, the site's
   address and the check, not on the site's row. Deleting the site and adding it back at the
   same address must not erase the opt-out either, and the re-check's own fix doesn't cover
   that case. `daily-reminders` (F1) checks the same table before it sends.
3. **Sending back the sign-off the app holds is not a new sign-off** (R3). `stamp_signoff()`
   compares the sign-off without its stamps, and compares `signed_at` as a time. If nothing
   changed it keeps the stored one, so `signed_by` keeps saying who signed, not who saved last.
4. **A reopened visit's start can't move past the completion date it will get back** (R4).
   When the start changes, check it against `coalesce(completed_at, first_completed_at)`. Don't
   also run the order check where a reopened visit gets its date back: a visit from before 0006
   whose dates are already out of order could then never be completed again once reopened.
5. **The app's usual upsert of a check must work** (R5). An upsert writes every column back,
   and Postgres asks for UPDATE on all of them, so grant UPDATE on `team_id`, `location_id`,
   `obligation` and `satisfied_by` too. Refuse changing the first three in a trigger, as
   visits do. `satisfied_by` may only be cleared or set to the check's own workflow, which
   is what `set_workflow_interval()` does; otherwise a cheap custom visit could keep a legal
   check up to date.
6. **A completed visit with no first completion on record still keeps its date** (R6), for
   rows written with the triggers off or between 0006's backfill and its triggers.
   `gate_visit_dates()` takes `coalesce(old.first_completed_at, old.completed_at)`, which also
   lets the backfill work on a re-run.
7. **Re-running 0006 on its own must keep 0007's `pack_in_use()`** (R7). Create it in 0006 only
   if it isn't there yet.
8. **Inside the import window, today's work still counts** (M.D. confirmed). A visit
   "started" before this month but completed in the last 7 days is current work, not
   history, so count it whether or not the window is open. Without this, one window lets a
   team bring in any number of such visits, uncounted and dated today.
9. **Clients, sites, floors and rooms keep their team** (from 0001). A member of two teams can
   move one of them into the other team and leave its children behind in the old one. Lock
   `team_id` on them, as visits now are.

Done when every item has a check in `run_tests.py` that fails on `41f7cc7` and passes with its
fix, both drafts apply twice, and the 255 existing checks still pass.

A second re-check, of the step's own commit, found three more gaps (S1–S3), fixed in the same
step:

- One write that moves a reopened visit's start and completes it is checked against the
  date it will end with, the first completion date, not the one the app sent.
- The `satisfied_by` rule applies when a check is added, not only when it is edited.
- Opt-out keys ignore doubled and surrounding spaces as well as case (`opt_out_key()`), so an
  address typed again with a stray space still matches.

#### A4. Apply

1. Move the drafts into `supabase/migrations/` as `0006_editions.sql` and
   `0007_compliance_and_reports.sql`.
2. With M.D.'s go-ahead, run them in the Supabase SQL editor. Check each verification
   result; the existing team should read `pro · comped · av`, and 0007's
   `cross_team_rows` must be 0 (any other number is old data to look at by hand). 0006
   replaces each team's 6-character join code with a 12-character one; nothing in the app
   shows the code.
3. In Dashboard → Storage, give the `evidence` bucket a size limit and image types only;
   0007 sets the `reports` bucket's limits itself.
4. Run `tests/rls.mjs` and the existing suites. Limits stay off.

### Phase B — App foundations

#### B1. Pack files

- Create `src/data/packs/{core,av,vic_rental,qld_electrical,electrical_general}.js`. Each
  exports the pack id and label, its workflows (id, label, page config like
  `PreventativeMaintenance.jsx`), and template seeds.
- Move the AV lists from `testLists.js` unchanged.
- Share common lists between packs in code, such as the AS/NZS 3019 electrical list.
- `templateStore.seed(kind)` looks the workflow up in a pack registry instead of today's
  if/else.
- Done when: every workflow in the database catalogue has a pack file entry, and the AV
  suites pass unchanged.

#### B2. Template schema (backward compatible)

- `test.type`: `check` (PASS/FAIL/N/A, the default), `choice` (custom options such as
  checked / not applicable / not included), `yesno`, `measure` (`{ unit, min, max }` with
  an optional pass/fail rule) and `text`.
- `section.scope`: `room` (the default), `site`, or `item` with an `assetType`.
- `section.roomTypes`: switches a section on automatically in those room types.
- Coverage rules, for example `{ roomTypes: ['bedroom'], assetType: 'smoke_alarm', min: 1
  }`.
- The Excel export and the report snapshot handle every type.
- Done when: existing AV templates load and export exactly as before, and a test template
  using every type round-trips through the store.

#### B3. Offline and multiple devices (M.D.'s note in 2.2)

- Save the cache's unsaved changes (the data and the last-synced snapshot) to IndexedDB on
  every change, and restore them on load before reading from Supabase.
- Retry saving when the connection returns (the `online` event) and on a timer.
- Show "Saved", "Saving" or "Offline: changes are kept on this device".
- **Starting a visit online** waits for the database to accept it before the visit opens.
  Today Pemcora creates the visit in the app and saves it about 600 ms later; if that save
  were refused, the app would retry it on every save, and changes waiting behind it
  wouldn't save either.
- **Starting a visit offline** is allowed, and it's checked when the device reconnects.
- **Same visit started on another device** (duplicate error 23505): take the server's open
  visit id, merge anything entered locally room by room (newest edit wins), and carry on.
  But if that open visit is a reopened one (it has a `first_completed_at`), don't join it:
  it keeps its first completion date, so this inspection would be recorded under last
  year's. Say a correction to an earlier visit is still open, and finish that first.
- **Refused start** (402): move the visit out of the save queue into a "Not saved" area on
  the device, keep everything else saving, and retry it after an upgrade.
- Done when tests cover: a reload with unsaved changes, a dropped connection mid-visit, a
  visit continued the next day, two devices on the same visit, and a refused offline
  start.

#### B4. Entitlements in the app

- Read `team_entitlements()` when the app opens and after each visit starts.
- Tag each `nav.js` entry with its pack, and have `SideNav` show only the team's packs.
  Landlord and agency teams get their own navigation (Properties, Reports, Due).
- Add the usage indicator on visit pages, the upgrade sheet (2.11), and the banners for
  past due and plan ending.
- Done when: a team without a pack doesn't see its pages, and a 402 shows the upgrade sheet
  while any other error shows "Save failed".

#### B5. Sign-up (M.D.'s note in 2.3)

- Team Setup calls `create_organisation()`.
- Ask what the team does (AV integration, electrical work, landlord, property management)
  and which state it's in, then show the matched starter pack for confirmation, with a way
  to change it.
- On the same screen, offer the other packs as add-ons with prices, a "No add-on" choice
  selected by default, and "You can add packs any time."
- Until billing exists (Phase E), the add-on choices are shown but only noted. Step E1
  connects them to checkout.
- Done when: each row of the starter mapping table in 2.3 produces the right pack, and a
  landlord gets no pack.

### Phase C — Field work

#### C1. Workflow page

- A whole-site step for `site` sections.
- Sections repeated per item, listing the site's items of that type, with "Add item"
  inline.
- Inputs for readings, with units.
- Coverage warnings, such as "Bedroom 3 has no smoke alarm".
- An outcome declaration at sign-off (compliant or non-compliant).
- Sign-off with the technician's name, their licence number filled in, and a signature
  pad; saved to `visits.signoff`.
- After completing a reopened visit, show the completion date the database kept (its first
  one), not the device's.

#### C2. Equipment panel per site

- List, add and edit items, using the pack's fields for `attributes`.
- Replacing an item marks the old one removed and adds the new one.
- Expiry dates, and a photo of the label on Pro.

#### C3. Settings and client pages

- Company details: licence and REC numbers.
- Each technician's own licence number, in their member settings.
- The team-wide reminders switch.
- AV settings: "Regular PM visit: every N months" (the team default).
- Client page: "PM visits every N months" or "Use team default", the client's reminders
  switch, and the contact name, email and phone that reports and reminders go to.

#### C4. Due page

- From `due_list()`: overdue first, then due within 60 days, then "not done yet", then
  alarms expiring in the next 3 months.
- Filter by client.
- Each check has its own reminders switch, and the page shows checks a client has marked
  "no longer needed". It takes that from `reminder_opted_out()`, not from the check's own
  switch, which a team can make read "on" again by re-creating the check while the
  contact's email is blank.

### Phase D — Reports and landlords

#### D1. PDF builder

- Build PDFs in the browser with a library such as pdf-lib or jsPDF, with one layout per
  workflow.
- The Victorian electrical layout follows the ESV form, sections A to F plus
  certification.
- Photos are embedded at up to 1600 px on the long edge, as JPEG at about 70% quality.
- Include licence numbers and the signature, the logo on Pro, and the revision number on
  corrected reports.
- The Excel export stays.

#### D2. Sending

- A `deliver-report` Edge Function, modelled on `send-invite`, using the caller's own login
  token.
- Upload the PDF to `reports/<team_id>/<uuid>.pdf`, call `send_report()`, and email the
  link `#/r/<token>` through Resend.
- "Send again" calls `resend_report()`. "Withdraw" is available until the report is saved.
- Before the function emails anything, cap how many reports a team can send a day:
  `send_report()` has no limit yet, so any Free account could send unlimited email from
  Pemcora's domain to any address. (From the Phase A security review.)

#### D3. Report link page `#/r/<token>`

- Show the right state from `report_preview()`: the report, "this link has expired, ask
  [electrician] for a new one", or "this report has been saved, sign in to view it".
- A `report-file` Edge Function makes a PDF link that lasts a few minutes, and only in
  the cases where `report_preview()` would show the report.
- "Save to your account": sign up or sign in with the same email, then `claim_report()`,
  then filing (pick a property or create it from the report's address).

#### D4. Landlord and agency side

- Sign-up for landlords and agencies.
- Properties list with each property's due dates, received reports and PDFs.
- Hand-entered checks, with a certificate upload on Pro (decision D6).
- Remove a site link to stop automatic filing.
- Read deliveries through a view that leaves out the provider-side ids
  (`provider_team_id`, `provider_location_id`, `visit_id`, `sent_by`, and the sign-off's
  `signed_by` inside the snapshot).

### Phase E — Billing and limits

#### E1. Stripe

- Start by settling the pricing decisions D1 and D2 with M.D.
- Products and prices: Pro per seat, and add-on packs.
- Stripe Checkout, and the customer portal for card updates and cancellation, set to cancel
  at the end of the period.
- A `stripe-webhook` Edge Function using the service-role key writes `subscriptions`
  (plan, status, seats, `current_period_end`, `cancel_at`, `past_due_since`) and add-on
  `team_packs`.
- Events: `checkout.session.completed`, `customer.subscription.created`, `.updated` and
  `.deleted`, `invoice.payment_failed` and `invoice.paid`.
- Set Stripe's retries to finish within 7 days.
- Connect the sign-up add-on choices (B5) to checkout.

#### E2. Downgrade (M.D.'s note in 2.6)

When a subscription ends or an add-on is cancelled, the webhook removes the add-on
`team_packs` rows and adds a notice. It doesn't touch members, photos, visits or the
starter pack.

#### E3. Cancellation (M.D.'s note in 2.6)

- Cancellation only at the end of the paid period.
- Banner: "Pro ends on [date]. Finish these open visits before then:" with the list.
- Admin emails 7 days and 1 day before.

#### E4. Declined card (M.D.'s note in 2.6)

- Banner with the 7-day deadline and a link to update the card.
- Admin emails on days 0, 3 and 6.
- On day 7 the database treats the team as Free (A1 item 3).

#### E5. Notices (M.D.'s note in 2.7)

- The Teams page shows `team_notices`.
- A `notify-admins` Edge Function, triggered by a database webhook when a notice is added,
  emails the team's owners and admins.

#### E6. Go live

- Prices are final, and the webhook has been tested end to end in Stripe's test mode.
- With M.D.'s go-ahead: `update public.app_settings set enforce_limits = true;`

### Phase F — Reminders (M.D.'s note in 2.8)

#### F1. Daily reminder job

- A `daily-reminders` Edge Function, run each morning Sydney time by Supabase Cron.
- It picks items where all of these hold: the team is Pro with reminders on, the client has
  reminders on, the item is active with reminders on, `next_due_on` is within
  `remind_days_before`, and `last_reminded_at` is empty. It skips any check on the opt-out
  list from step A3b (asking `reminder_opted_out()`), whatever the item's own switch says.
- It records on the check the address each reminder went to (a `last_reminded_to`, say),
  and `reminder_opt_out()` keys the opt-out on that address, so a click counts for the
  person who was emailed, even if the client's contact has changed since.
- It also picks alarms entering the expiry window with no `expiry_reminded_at`.
- It sends one email per client contact per site, listing the checks due and the alarms
  expiring, with "Book your re-check" (the electrician's contact details) and a "No longer
  needed" link carrying the item's `reminder_token`.
- It sets `last_reminded_at` and `expiry_reminded_at`, and logs each send.

#### F2. "No longer needed" page

`#/stop/<token>` calls `reminder_opt_out()`, confirms "Reminders for [site] are off", and
notifies the electrician. It calls it when the client presses a button on the page, not
when the page loads: some mail scanners open every link in an email.

#### F3. Switches

Built in C3 and C4: team, client and individual check.

#### F4. Landlord reminders

Whether landlords get reminders about their own tracker is decision D8. Not in the first
release by default.

### Phase G — More packs (M.D.'s note in 2.1)

#### G1. Baseline

Ship `electrical_general` with step B1, using the lists in 3.5.

#### G2. One pack per state

For New South Wales, South Australia, Western Australia, Tasmania, the ACT and the
Northern Territory, and for Queensland's electrical check:

1. Research the official rules and forms: rental electrical and safety switch
   requirements, smoke alarm rules, intervals, who may do the work, and what the record
   must show.
2. Write the test list in the shape of 3.3, with an electrical safety check and a smoke
   alarm check.
3. Have a licensed electrician check it.
4. Add the pack and workflows to the catalogue, fixing intervals where the law sets them.
5. Add the pack file to the app.
6. Release it, and give it free to that state's teams on `electrical_general`. The locks
   from step A3b bind the SQL editor too: a check's site, team and obligation can't be
   changed, and its `satisfied_by` must match its obligation. So moving those teams' existing
   checks onto the new pack's workflows needs new checks made alongside, or a migration that
   sets the triggers aside deliberately.

### Phase H — Tests and docs

- Extend `tests/rls.mjs` with the cross-team rules: landlords never see a provider's
  clients, sites, visits or notes; reports reach them only through deliveries; seats;
  photos; plans can be read but not written.
- Add an end-to-end suite for each new feature.
- Update `docs/editions/data-model.md`, `README.md` and `tests/README.md`.

---

## 5. Open decisions (with defaults)

| # | Decision | Default in this plan |
|---|---|---|
| D1 | Pricing for Pro per seat and for add-on packs | settled with M.D. at the start of Phase E |
| D2 | Can a Free team buy an add-on, or do add-ons need Pro? | add-ons need Pro; confirmed with M.D. at the start of Phase E |
| D3 | A Victorian electrical check and smoke alarm check at the same house on the same day | 2 inspections |
| D4 | After Pro ends, visits still open | stay editable |
| D5 | Public view of report links | 90 days |
| D6 | Landlords uploading their own certificates | Pro |
| D7 | AV sites with no PM visit yet when a regular interval is set | "Not done yet", no due date |
| D8 | Reminders for landlords about their own tracker | not in the first release |
| D9 | Who can upgrade and manage billing | owners and admins |
| D10 | Store lease dates for Queensland rentals (due within 30 days before each lease) | not yet; the 12-month repeat stands in |
| D11 | One person running several Free teams, each with its own inspection a month | allowed, since limits are per team; revisit before E6 |

## 6. Known limits

- Each report goes to one email address, so an agency can't yet pass a report on to the
  owner inside Pemcora.
- Reopening a completed visit doesn't roll back due dates, and completing it again doesn't
  move them on.
- Your logo on reports is only a soft limit while PDFs are made in the browser.
- A team that deletes every visit under its starter pack, and has sent no report under it,
  can swap it, but it loses that work and the month's inspection isn't given back.
- A file uploaded to `reports/` that no delivery names stays there: nothing can delete
  report files. A cleanup of unnamed ones would be a later step.

## 7. Sources for the pack lists

- [Energy Safe Victoria — Electrical Safety Check Report form](https://www.energysafe.vic.gov.au/pdfs/electrical-safety-check-report-online-form)
- [Energy Safe Victoria — sample Electrical Safety Check Report](https://app.production.energysafe-vic-gov-au.sdp3.sdp.vic.gov.au/sites/default/files/2022-12/ElectricalSafetyCheckReport_sample_May2021.pdf)
- [Consumer Affairs Victoria — Rental providers: gas and electrical safety](https://www.consumer.vic.gov.au/housing/renting/repairs-alterations-safety-and-pets/gas-electrical-and-water-safety-standards/rental-providers-gas-and-electrical-safety)
- [Consumer Affairs Victoria — Smoke alarms and fire safety](https://www.consumer.vic.gov.au/housing/renting/repairs-alterations-safety-and-pets/keeping-the-property-safe/smoke-alarms-and-fire-safety)
- [Victorian fire services — Smoke alarm factsheet for rental providers](https://www.cfa.vic.gov.au/ArticleDocuments/381/CFA%20Smoke%20Alarm%20Factsheet%20for%20Rental%20Providers%20-%20July%202021.pdf.aspx)
- [Queensland Fire — Smoke alarm legislation information sheet](https://fire.qld.gov.au/sites/default/files/2021-05/SmokeAlarmLegislationInformationSheet.pdf)
- [Queensland Fire — Smoke alarm installation information sheet](https://fire.qld.gov.au/sites/default/files/2021-05/SmokeAlarmInstallationInformationSheet.pdf)
- [Residential Tenancies Authority (QLD) — Smoke alarms](https://www.rta.qld.gov.au/during-a-tenancy/maintenance-and-repairs/smoke-alarms)
- [CEHL — Safety related activities guide and checklist](https://cehl.com.au/wp-content/uploads/2024/06/SAFETY-RELATED-ACTIVITIES-Guide-and-Checklist-1.pdf)
