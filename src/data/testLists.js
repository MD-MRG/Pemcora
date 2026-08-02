// Seed test lists for the new console.
//
// Ordered arrays of labels — stable ids and `order` are assigned when a team's
// lists are first created, so renaming a test never orphans existing results
// (the rule carried over from the previous app).
//
// These are seeds only. Once a team exists, its lists are edited in-app through
// the test-list editor, and edits never alter already-completed work.

// Each workflow owns its own copy of every list. Commissioning and Maintenance
// start with identical sub-lists but are seeded separately, so editing one never
// touches the other — they are free to diverge.
//
// Source: "Updated commisioning List.xlsx" (Desktop\Claude\Apps\App version 3).
// Handover verification — the fuller list, covering setup and configuration.
export const COMMISSIONING = {
  main: [
    'Correct Time and Date',
    'Room Wake On Touch',
    'Test network connectivity to all AV devices',
    'Display image calibration and scaling',
    'Audio DSP routing and tuning',
    'Teams room account signed in',
    'Touch panel functionality check',
    'Test call performed',
    'Audio In room',
    'Audio to Remote participants',
    'Video In room',
    'Video to Remote participants',
    'Audio quality',
    'Video quality',
    'Content video In room',
    'Content video Remote participants',
    'Content audio In room',
    'Content audio Remote participants',
    'Cameras working as specified',
    'Hearing Augmentation',
    'TV Remote available',
    'TV Volume turned down',
    'FW updated',
    'Booking panel signed in with calendar displayed',
    'BYOD',
  ],
  roomControls: [
    'Room ON/OFF',
    'Source selection',
    'Speaker Volume',
    'Speaker Mute',
    'Mic Volume',
    'Mic Mute',
    'Ceiling Mic LED Mute Sync',
    'Camera Control',
    'Camera Presets',
  ],
  additionalSources: ['Signage', 'Apple TV', 'Foxtel', 'FTA STB', 'Sonos'],
}

// Supplied 2026-07-29. Recurring service visit — drops the one-off setup checks
// and runs the in-room/remote pairs in a different order to commissioning.
export const MAINTENANCE = {
  main: [
    'Correct Time and Date',
    'Room Wake On Touch',
    'Test call performed',
    'Audio In room',
    'Video In room',
    'Audio to Remote participants',
    'Video to Remote participants',
    'Content video In room',
    'Content video Remote participants',
    'Content audio In room',
    'Content audio Remote participants',
    'Video quality',
    'Audio quality',
    'Cameras working as specified',
    'Hearing Augmentation',
    'TV Remote available',
    'FW updated',
    'Booking panel signed in with calendar displayed',
    'BYOD',
  ],
  roomControls: [
    'Room ON/OFF',
    'Source selection',
    'Speaker Volume',
    'Speaker Mute',
    'Mic Volume',
    'Mic Mute',
    'Ceiling Mic LED Mute Sync',
    'Camera Control',
    'Camera Presets',
  ],
  additionalSources: ['Signage', 'Apple TV', 'Foxtel', 'FTA STB', 'Sonos'],
}

// Custom List seeds nothing — a job starts with an empty main section and the
// technician adds named sections as needed.
export const CUSTOM = { main: [], sections: [] }

/* ── Structural note ─────────────────────────────────────────────────────────
   Custom List needs an arbitrary number of user-named sections, and the section
   headings themselves ("Main test list", "Room specifics") must be renameable.
   That is more general than the previous app's fixed three lists, so the schema
   should model a template as:

       template = { mainLabel, sections: [ { id, label, order, tests[] } ] }

   Commissioning and Maintenance are then just templates that ship with two
   sections pre-named "Room controls" and "Additional AV Sources" — no special
   casing, and one editor serves all three workflows.
   ────────────────────────────────────────────────────────────────────────── */
