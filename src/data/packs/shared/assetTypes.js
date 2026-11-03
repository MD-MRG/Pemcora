// The kinds of equipment the packs test item by item. The key is what an item
// stores (assets.asset_type) and what a section's `assetType` and a coverage
// rule name, so it never changes once a pack has shipped.
//
// `fields` are each type's own details, kept in assets.attributes under their
// id, which never changes either. Every item also has a name, a room, make,
// model, serial number, installed and expiry dates: those are columns.
//
//   type   'choice' (from `options`, [value, label]), 'yesno', 'text' or 'date'
//
// Like the test lists, these are proposals until the electrician checks them.

export const ASSET_TYPES = {
  smoke_alarm: {
    label: 'Smoke alarm',
    noun: 'smoke alarm',
    plural: 'smoke alarms',
    // AS 3786: replaced ten years from the date of manufacture on its label.
    lifeYears: 10,
    fields: [
      {
        id: 'sensor',
        label: 'Sensor',
        type: 'choice',
        options: [
          ['photoelectric', 'Photoelectric'],
          ['ionisation', 'Ionisation'],
          ['heat', 'Heat'],
          ['multi', 'Multi-sensor'],
        ],
      },
      {
        id: 'power',
        label: 'Power',
        type: 'choice',
        options: [
          ['mains', '240 V hard-wired'],
          ['lithium', 'Sealed 10-year battery'],
          ['battery', 'Removable 9 V battery'],
        ],
      },
      { id: 'interconnected', label: 'Interconnected', type: 'yesno' },
      { id: 'as3786', label: 'Marked AS 3786-2014', type: 'yesno' },
      { id: 'manufactured', label: 'Manufactured', type: 'date' },
    ],
  },
  rcd: {
    label: 'RCD',
    noun: 'RCD',
    plural: 'RCDs',
    fields: [
      { id: 'circuits', label: 'Circuits protected', type: 'text' },
      {
        id: 'rating',
        label: 'Rated trip current',
        type: 'choice',
        options: [
          ['30', '30 mA'],
          ['10', '10 mA'],
        ],
      },
      {
        id: 'form',
        label: 'Form',
        type: 'choice',
        options: [
          ['rcbo', 'RCBO (with circuit breaker)'],
          ['rcd', 'Stand-alone RCD'],
        ],
      },
    ],
  },
}

/** 'Smoke alarm', or the key itself for a type no pack names. */
export const assetTypeLabel = id => ASSET_TYPES[id]?.label ?? id

/** 'smoke alarms', or the key itself for a type no pack names. */
export const assetTypePlural = id => ASSET_TYPES[id]?.plural ?? id

/** 'smoke alarm' mid-sentence, or the key itself. */
export const assetTypeNoun = id => ASSET_TYPES[id]?.noun ?? id

/** The type's own fields; none for a type no pack names. */
export const assetFields = id => ASSET_TYPES[id]?.fields ?? []
