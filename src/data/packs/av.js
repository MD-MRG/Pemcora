// AV maintenance and commissioning — the lists Pemcora started with.
//
// Ordered arrays of labels — stable ids and `order` are assigned when a team's
// lists are first created, so renaming a test never orphans existing results
// (the rule carried over from the previous app).
//
// Each workflow owns its own copy of every list. Commissioning and Maintenance
// start with identical sub-lists but are seeded separately, so editing one never
// touches the other — they are free to diverge.

// Source: "Updated commisioning List.xlsx" (Desktop\Claude\Apps\App version 3).
// Handover verification — the fuller list, covering setup and configuration.
const COMMISSIONING = {
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
const MAINTENANCE = {
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

// Both workflows ship with the same two optional sections, each switched on per
// room (see the note in ./index.js).
const seed = src => ({
  main: src.main,
  sections: [
    { label: 'Room controls', tests: src.roomControls },
    { label: 'Additional AV Sources', tests: src.additionalSources },
  ],
})

export default {
  id: 'av',
  label: 'AV maintenance and commissioning',
  workflows: [
    {
      // Recurring service visits. Shares its whole workflow with Commissioning —
      // only the test template and the wording differ.
      id: 'maintenance',
      label: 'Preventative maintenance',
      page: {
        title: 'Preventative Maintenance',
        progressNoun: 'Preventative Maintenance',
        startLabel: 'Start PM',
        newLabel: 'Start new visit',
        emptyLine: 'No PM recorded for this location',
        reportTitle: 'Preventative Maintenance',
      },
      seed: seed(MAINTENANCE),
    },
    {
      // Handover verification. Same workflow as Preventative Maintenance, its own
      // test template, and its own visit history — `kind` is what keeps the two
      // apart, so a commissioning in progress never blocks or gets confused with a PM.
      id: 'commissioning',
      label: 'Commissioning',
      page: {
        title: 'Commissioning',
        progressNoun: 'Commissioning',
        startLabel: 'Start commissioning',
        newLabel: 'Start new commissioning',
        emptyLine: 'No commissioning recorded for this location',
        reportTitle: 'Commissioning',
      },
      seed: seed(COMMISSIONING),
    },
  ],
}
