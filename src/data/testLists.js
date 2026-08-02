// Seed test lists for the new console.
//
// Ordered arrays of labels — stable ids and `order` are assigned when a team's
// lists are first created, so renaming a test never orphans existing results
// (the rule carried over from the previous app).
//
// These are seeds only. Once a team exists, its lists are edited in-app through
// the test-list editor, and edits never alter already-completed work.

// Source: "Updated commisioning List.xlsx" (Desktop\Claude\Apps\App version 3).
export const COMMISSIONING_MAIN = [
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
]

// Sub-lists revealed by "Room specifics = YES".
export const COMMISSIONING_ROOM_CONTROLS = [
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

export const COMMISSIONING_ADDITIONAL_SOURCES = [
  'Signage',
  'Apple TV',
  'Foxtel',
  'FTA STB',
  'Sonos',
]

// Preventative Maintenance lists arrive separately.
