// The equipment panel's rules (src/workflows/EquipmentPanel.jsx). Pure, so they
// run in Node as well.

import { scopeOf } from './testTypes.js'
import { ASSET_TYPES, assetFields, assetTypeLabel } from '../data/packs/shared/assetTypes.js'

// An alarm is flagged this long before it expires, as the Due page lists them.
export const EXPIRY_WARNING_MONTHS = 3

/** The item types a list tests one by one, each once, in the list's order. */
export const panelTypes = template => [
  ...new Set(
    (template?.sections ?? []).filter(s => scopeOf(s) === 'item' && s.assetType).map(s => s.assetType),
  ),
]

/** Today on this device, as a date column holds it: '2026-11-03'. */
export const localDate = (now = new Date()) =>
  [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')

/** `date` plus some months, as a date: the 31st becomes the last of a shorter month. */
export function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/** When an item of this type made on `manufactured` expires, or null if its type doesn't. */
export function expiryFrom(manufactured, assetType) {
  const years = ASSET_TYPES[assetType]?.lifeYears
  if (!years || !/^\d{4}-\d{2}-\d{2}$/.test(manufactured ?? '')) return null
  return addMonths(manufactured, years * 12)
}

/** 'expired', 'soon' (within EXPIRY_WARNING_MONTHS) or null. A removed item is neither. */
export function expiryState(asset, today = localDate()) {
  if (!asset?.expiresOn || asset.removedAt) return null
  if (asset.expiresOn <= today) return 'expired'
  return asset.expiresOn <= addMonths(today, EXPIRY_WARNING_MONTHS) ? 'soon' : null
}

/** A date column shown as the device shows dates. */
export const showDate = date => {
  if (!date) return ''
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString()
}

/** One of a type's fields, as words: 'Photoelectric', 'Yes'. Blank when not recorded. */
export function fieldText(field, value) {
  if (value == null || value === '') return ''
  if (field.type === 'choice') return field.options.find(([v]) => v === value)?.[1] ?? String(value)
  if (field.type === 'yesno') return value === true ? 'Yes' : value === false ? 'No' : ''
  if (field.type === 'date') return showDate(value)
  return String(value)
}

/** What the panel says about an item under its name: 'Photoelectric · 240 V hard-wired'. */
export const itemSummary = asset =>
  [
    ...assetFields(asset.assetType)
      .filter(f => f.type === 'choice')
      .map(f => fieldText(f, asset.attributes?.[f.id])),
    [asset.make, asset.model].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(' · ')

/** An item's name, or its type and place among the site's items of that type. */
export const itemName = (asset, index) => asset.label || `${assetTypeLabel(asset.assetType)} ${index + 1}`
