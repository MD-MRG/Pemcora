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
