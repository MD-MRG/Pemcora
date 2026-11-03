// Victorian rental safety checks: an electrical safety check every 24 months
// and a smoke alarm safety check every 12 months, both fixed by law.
//
// PROPOSED — built from the official forms and rules (build plan, 3.3). A
// licensed electrician checks these lists before any team can use them.

import { VIC_ELECTRICAL_SAFETY } from './shared/electricalSafety.js'
import { replaceOnFail } from './shared/smokeAlarm.js'
import { HOME_ROOM_TYPES } from './shared/roomTypes.js'

export default {
  id: 'vic_rental',
  label: 'Victorian rental safety checks',
  tagline: 'Electrical compliance',
  proposed: true,
  roomTypes: HOME_ROOM_TYPES,
  workflows: [
    {
      // Mirrors Energy Safe Victoria's report form section for section.
      id: 'vic_electrical_safety',
      label: 'Electrical safety check',
      // Its page in the navigation, and where Home's Resume goes.
      nav: {
        path: '/vic-electrical-safety',
        label: 'VIC electrical safety',
        blurb: 'Victorian rental electrical safety checks, every 2 years',
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
      },
      seed: VIC_ELECTRICAL_SAFETY,
    },
    {
      // Required for every Victorian rental since 25 November 2025. The next
      // check's due date comes from Pemcora's records, not from the list.
      id: 'vic_smoke_alarm',
      label: 'Smoke alarm safety check',
      // Its page in the navigation, and where Home's Resume goes.
      nav: {
        path: '/vic-smoke-alarm',
        label: 'VIC smoke alarms',
        blurb: 'Victorian rental smoke alarm checks, every year',
        icon: 'alarm',
      },
      page: {
        title: 'Smoke Alarm Safety Check',
        progressNoun: 'Smoke alarm safety check',
        startLabel: 'Start smoke alarm check',
        newLabel: 'Start new smoke alarm check',
        emptyLine: 'No smoke alarm check recorded for this location',
        reportTitle: 'Smoke Alarm Safety Check',
        sheetName: 'Smoke Alarm Safety Check',
      },
      seed: {
        main: [],
        sections: [
          {
            label: 'Each smoke alarm',
            scope: 'item',
            assetType: 'smoke_alarm',
            tests: [
              replaceOnFail('Marked AS 3786'),
              'Correctly installed',
              replaceOnFail("Works when tested to the manufacturer's instructions"),
              'Battery fitted and replaced where needed (a removable 9 V battery replaced every year)',
              replaceOnFail('Hard-wired with a backup battery, if the building dates from after 1 August 1997'),
              'Interconnected, if built after 1 May 2014 and more than one alarm is required',
              replaceOnFail('Under 10 years old'),
            ],
          },
          {
            label: 'Whole property',
            scope: 'site',
            tests: [
              'At least one alarm on each level',
              'An alarm between each sleeping area and the rest of the house',
              // The rental provider's duty at the start of a tenancy; N/A otherwise.
              'Renter given written information on how each alarm works and how to test it',
            ],
          },
        ],
      },
    },
  ],
}
