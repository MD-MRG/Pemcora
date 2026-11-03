// Queensland electrical and smoke alarm compliance: a smoke alarm compliance
// inspection every 12 months (fixed by law) and an electrical safety check
// every 24 months by default.
//
// PROPOSED — built from the official rules (build plan, 3.4). A licensed
// electrician checks these lists before any team can use them.

import { ELECTRICAL_SAFETY } from './shared/electricalSafety.js'
import { replaceOnFail } from './shared/smokeAlarm.js'
import { HOME_ROOM_TYPES } from './shared/roomTypes.js'

export default {
  id: 'qld_electrical',
  label: 'Queensland electrical and smoke alarm compliance',
  tagline: 'Electrical compliance',
  proposed: true,
  roomTypes: HOME_ROOM_TYPES,
  workflows: [
    {
      // Rentals also need it within 30 days before each lease starts or renews;
      // Pemcora doesn't store lease dates, so the 12-month repeat stands in
      // (decision D10). The report doubles as the compliance certificate.
      id: 'qld_smoke_alarm',
      label: 'Smoke alarm compliance inspection',
      // How often it recurs, as the database catalogue says (0006).
      interval: { months: 12, fixed: true },
      // Its page in the navigation, and where Home's Resume goes.
      nav: {
        path: '/qld-smoke-alarm',
        label: 'QLD smoke alarms',
        blurb: 'Queensland smoke alarm compliance inspections, every year',
        icon: 'alarm',
      },
      page: {
        title: 'Smoke Alarm Compliance Inspection',
        progressNoun: 'Smoke alarm inspection',
        startLabel: 'Start smoke alarm inspection',
        newLabel: 'Start new smoke alarm inspection',
        emptyLine: 'No smoke alarm inspection recorded for this location',
        reportTitle: 'Smoke Alarm Compliance Inspection',
        sheetName: 'Smoke Alarm Inspection',
        // Finished by signing off: the outcome, and the technician's name, licence
        // number and signature (C1).
        signoff: true,
        // A failed smoke alarm's note is the reason it failed (M.D.'s note in B2).
        notePrompt: 'Why did it fail?',
      },
      seed: {
        main: [],
        sections: [
          {
            label: 'Each smoke alarm',
            scope: 'item',
            assetType: 'smoke_alarm',
            tests: [
              replaceOnFail('Photoelectric, marked AS 3786-2014'),
              replaceOnFail('No ionisation sensor'),
              replaceOnFail('Under 10 years old (manufacture date on the alarm)'),
              replaceOnFail(
                'Hard-wired with a backup battery, or a sealed 10-year battery (a hard-wired alarm is only replaced with another hard-wired one)',
              ),
              'Interconnected with every other alarm',
              'On the ceiling where practicable',
              'At least 300 mm from a wall-ceiling corner',
              'At least 300 mm from a light fitting',
              'At least 400 mm from an air-conditioning vent',
              'At least 400 mm from ceiling-fan blades',
              replaceOnFail('Works when tested (replaced immediately if not)'),
              'Cleaned',
            ],
          },
          {
            // The rules are written per storey; a whole-site section asks them
            // of every storey at once.
            label: 'Every storey',
            scope: 'site',
            tests: [
              'An alarm in every bedroom',
              "An alarm in hallways connecting bedrooms to the rest of the dwelling, or between the bedrooms and the rest of the storey if there's no hallway",
              'On a storey without bedrooms, an alarm in the most likely path out of the dwelling',
              'All alarms sound together when one is set off',
              'Stairways, sloping ceilings and exposed beams placed as the Building Fire Safety Regulation 2008 requires',
            ],
          },
        ],
        coverage: [{ roomTypes: ['bedroom'], assetType: 'smoke_alarm', min: 1 }],
      },
    },
    {
      // Starts with the baseline list; step G2 adds Queensland's own rules.
      id: 'qld_electrical_safety',
      label: 'Electrical safety check',
      // How often it recurs, as the database catalogue says (0006).
      interval: { months: 24, fixed: false },
      // Its page in the navigation, and where Home's Resume goes.
      nav: {
        path: '/qld-electrical-safety',
        label: 'QLD electrical safety',
        blurb: 'Queensland electrical safety checks, every 2 years unless you set otherwise',
        icon: 'electrical',
      },
      page: {
        title: 'Electrical Safety Check',
        progressNoun: 'Electrical safety check',
        startLabel: 'Start electrical safety check',
        newLabel: 'Start new electrical safety check',
        emptyLine: 'No electrical safety check recorded for this location',
        reportTitle: 'Electrical Safety Check',
        sheetName: 'Electrical Safety Check',
        // Finished by signing off: the outcome, and the technician's name, licence
        // number and signature (C1).
        signoff: true,
      },
      seed: ELECTRICAL_SAFETY,
    },
  ],
}
