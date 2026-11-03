// The kinds of equipment the packs test item by item. The key is what an item
// stores (assets.asset_type) and what a section's `assetType` and a coverage
// rule name, so it never changes once a pack has shipped. C2 adds each type's
// own fields.

export const ASSET_TYPES = {
  smoke_alarm: { label: 'Smoke alarm', noun: 'smoke alarm', plural: 'smoke alarms' },
  rcd: { label: 'RCD', noun: 'RCD', plural: 'RCDs' },
}

/** 'Smoke alarm', or the key itself for a type no pack names. */
export const assetTypeLabel = id => ASSET_TYPES[id]?.label ?? id

/** 'smoke alarms', or the key itself for a type no pack names. */
export const assetTypePlural = id => ASSET_TYPES[id]?.plural ?? id

/** 'smoke alarm' mid-sentence, or the key itself. */
export const assetTypeNoun = id => ASSET_TYPES[id]?.noun ?? id
