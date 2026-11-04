// The whole-site step's rules, shared by the visit's room list and the step
// itself (src/workflows/SiteStep.jsx). Pure, so they run in Node as well.

import { coverageGaps, scopeOf } from './testTypes.js'
import { assetTypeNoun } from '../data/packs/shared/assetTypes.js'

// What the page opens in place of a room id to show the whole-site step.
export const SITE = 'site'

/** The sections of a list the whole-site step covers. */
export const siteSectionsOf = template => (template?.sections ?? []).filter(s => scopeOf(s) !== 'room')

/** A list with nothing to do room by room: Continue opens the whole-site step. */
export const isSiteOnly = template =>
  siteSectionsOf(template).length > 0 &&
  !template.tests?.length &&
  !(template.sections ?? []).some(s => scopeOf(s) === 'room')

/** The coverage gaps at a site, in words: "Bedroom 3 has no smoke alarm". */
export const gapLines = (template, rooms, assets) =>
  coverageGaps(template, rooms, assets).map(
    ({ rule, room }) => `${room.name || 'Unnamed room'} has no ${assetTypeNoun(rule.assetType)}`,
  )

/**
 * The items a section repeated per item covers: every item of its type at the
 * site, and any removed since that this visit answered for.
 */
export const itemsFor = (section, assets, answers) =>
  (assets ?? []).filter(a => a.assetType === section.assetType && (!a.removedAt || answers?.[a.id]))
