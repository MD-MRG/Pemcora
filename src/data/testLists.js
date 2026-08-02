// Seed test lists for the new console.
//
// Ordered arrays of labels — stable ids and `order` are assigned when a team's
// lists are first created, so renaming a test never orphans existing results
// (the rule carried over from the previous app).
//
// These are seeds only. Once a team exists, its lists are edited in-app through
// the test-list editor, and edits never alter already-completed work.

// Room controls and Additional AV Sources are currently identical across both
// workflows. Whether they stay linked (edit once, applies to both) or become
// independent per workflow is an open decision — see the note at the foot.
const ROOM_CONTROLS = [
  'Room ON/OFF',
  'Source selection',
  'Speaker Volume',
  'Speaker Mute',
  'Mic Volume',
  'Mic Mute',
  'Ceiling Mic LED Mute Sync',
  'Camera Control',
  'Camera Presets',
]

const ADDITIONAL_SOURCES = ['Signage', 'Apple TV', 'Foxtel', 'FTA STB', 'Sonos']

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
  roomControls: ROOM_CONTROLS,
  additionalSources: ADDITIONAL_SOURCES,
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
  roomControls: ROOM_CONTROLS,
  additionalSources: ADDITIONAL_SOURCES,
}

// Open for the Commissioning & Maintenance step:
//   1. Are the two sub-lists shared between workflows, or independent copies a
//      team can diverge?
//   2. Custom List presumably starts empty and is built per job — confirm.
