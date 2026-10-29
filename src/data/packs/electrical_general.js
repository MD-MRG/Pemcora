// Electrical compliance baseline, for electricians in states without their own
// pack yet. Each state's own rules replace it in step G2, so nothing in it is
// fixed by law.
//
// PROPOSED — built from AS/NZS 3019 and the National Construction Code (build
// plan, 3.5). A licensed electrician checks these lists before any team can
// use them.

import { ELECTRICAL_SAFETY } from './shared/electricalSafety.js'

export default {
  id: 'electrical_general',
  label: 'Electrical compliance baseline',
  proposed: true,
  workflows: [
    {
      id: 'electrical_safety',
      label: 'Electrical safety check',
      page: {
        title: 'Electrical Safety Check',
        progressNoun: 'Electrical safety check',
        startLabel: 'Start electrical safety check',
        newLabel: 'Start new electrical safety check',
        emptyLine: 'No electrical safety check recorded for this location',
        reportTitle: 'Electrical Safety Check',
      },
      seed: ELECTRICAL_SAFETY,
    },
    {
      // The next check's due date comes from Pemcora's records, not the list.
      id: 'smoke_alarm_check',
      label: 'Smoke alarm check',
      page: {
        title: 'Smoke Alarm Check',
        progressNoun: 'Smoke alarm check',
        startLabel: 'Start smoke alarm check',
        newLabel: 'Start new smoke alarm check',
        emptyLine: 'No smoke alarm check recorded for this location',
        reportTitle: 'Smoke Alarm Check',
      },
      seed: {
        main: [],
        sections: [
          {
            label: 'Each smoke alarm',
            scope: 'item',
            assetType: 'smoke_alarm',
            tests: [
              'Marked AS 3786',
              'Correctly installed',
              "Works when tested to the manufacturer's instructions",
              'Battery fitted and replaced where needed',
              'Interconnected where required',
              'Under 10 years old',
            ],
          },
          {
            label: 'Whole dwelling',
            scope: 'site',
            tests: [
              'At least one alarm on each storey',
              'Alarms between the bedrooms and the rest of the dwelling, and in hallways serving bedrooms, as the National Construction Code requires',
            ],
          },
        ],
      },
    },
  ],
}
