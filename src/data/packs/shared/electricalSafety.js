// The electrical safety check, following section 4 of AS/NZS 3019 (periodic
// assessment). One list, shared by every electrician pack: Victoria's check
// labels its sections as Energy Safe Victoria's report form does
// (ESV-RTR-ESC 01.1), and the baseline and Queensland checks use it as is.
//
// PROPOSED — a licensed electrician checks it before any team can use it.
//
// Section A of the form (address, date of the previous check), the "next
// smoke alarm check due" line and the certification block are not here: they
// come from Pemcora's records, Settings and the sign-off, and the report fills
// them in. Readings carry no pass/fail limits until the electrician sets them.

const INCLUDED = ['Included', 'Not applicable', 'Not included']
const CHECKED = ['Checked', 'Not applicable', 'Not included']

const choice = options => label => ({ label, type: 'choice', options })
const ohms = label => ({ label, type: 'measure', unit: 'Ω' })

// `ref` is the form's own section letter, used only by the Victorian check.
const SECTIONS = [
  {
    ref: 'B',
    label: 'Extent of installation',
    scope: 'site',
    tests: [
      'Main switchboard',
      'Main earthing system',
      'Kitchen',
      'Main bathroom',
      'Other bathrooms and ensuites',
      'Main bedroom',
      'Other bedrooms',
      'Living room',
      'Other living areas',
      'Laundry',
      'Garage',
      'Solar or battery system',
      'Electric water heater',
      'Dishwasher',
      'Electric room or space heaters',
      'Swimming pool equipment',
    ].map(choice(INCLUDED)),
  },
  {
    ref: 'C',
    label: 'Visual inspection',
    scope: 'site',
    tests: [
      'Consumers mains',
      'Switchboards',
      'Exposed earth electrode',
      'Metallic water pipe bond',
      'RCDs (safety switches)',
      'Circuit protection (circuit breakers and fuses)',
      'Socket-outlets',
      'Light fittings',
      'Installation wiring',
      'Electric water heater',
      'Air conditioners',
      'Space heaters',
      'Cooking equipment',
      'Dishwasher',
      'Exhaust fans',
      'Ceiling fans',
      'Washing machine or dryer',
      'Solar and other renewable systems',
      'Swimming pool equipment',
      'Vehicle chargers',
    ].map(choice(CHECKED)),
  },
  {
    ref: 'D1',
    label: 'Polarity and correct connections',
    scope: 'site',
    tests: [
      'Consumers mains',
      'Circuit protection',
      'RCDs',
      'Socket-outlets',
      'Light fittings',
      'Electric water heater',
      'Air conditioners',
      'Cooking equipment',
      'Dishwasher',
      'Solar and other renewable systems',
      'Swimming pool equipment',
      'Vehicle chargers',
    ].map(choice(CHECKED)),
  },
  {
    // A reading in ohms, or a note such as "double insulated".
    ref: 'D2',
    label: 'Earth continuity',
    scope: 'site',
    tests: [
      'Mains earth conductor',
      'Switchboard enclosure',
      'Metallic water pipe bond',
      'Socket-outlets',
      'Light fittings',
      'Exhaust fans',
      'Ceiling fans',
      'Electric water heater',
      'Air conditioners',
      'Cooking equipment',
      'Dishwasher',
      'Solar and other renewable systems',
      'Swimming pool equipment',
      'Vehicle chargers',
    ].map(ohms),
  },
  {
    // Repeated for each RCD at the site, its results saved under that RCD.
    ref: 'D3',
    label: 'RCD testing',
    scope: 'item',
    assetType: 'rcd',
    tests: [
      { label: 'Circuit protected', type: 'text' },
      { label: 'Push-button test' },
      { label: 'Time test' },
      { label: 'Trip time', type: 'measure', unit: 'ms' },
    ],
  },
  {
    ref: 'E',
    label: 'Smoke alarms',
    scope: 'site',
    tests: [
      {
        label:
          "All smoke alarms correctly installed, working and tested to the manufacturer's instructions",
        type: 'yesno',
      },
    ],
  },
  {
    ref: 'F',
    label: 'Observations and recommendations',
    scope: 'site',
    tests: [
      { label: 'Each defect and what was done (repaired, replaced, retested)', type: 'text' },
    ],
  },
]

const withoutRef = ({ ref: _ref, ...section }) => section

// The whole check is one list for the property, so the room-by-room main list
// stays empty.
export const ELECTRICAL_SAFETY = { main: [], sections: SECTIONS.map(withoutRef) }

export const VIC_ELECTRICAL_SAFETY = {
  main: [],
  sections: SECTIONS.map(({ ref, label, ...section }) => ({ label: `${ref}. ${label}`, ...section })),
}
