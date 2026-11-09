// What a new team is asked, and the starter pack its answers lead to (build plan 2.3).
//
// The team confirms the match on the next screen and can change it, and the database
// doesn't check it: a team is free to start on any pack that's on offer.

import { packById } from '../data/packs/index.js'

export const TRADES = [
  { id: 'av', label: 'AV integration', accountType: 'provider' },
  { id: 'electrical', label: 'Electrical work', accountType: 'provider', asksState: true },
  { id: 'landlord', label: 'Landlord', accountType: 'landlord' },
  { id: 'property', label: 'Property management', accountType: 'agency' },
]

// Matches the check on teams.state in 0008.
export const STATES = [
  { id: 'VIC', label: 'Victoria' },
  { id: 'QLD', label: 'Queensland' },
  { id: 'NSW', label: 'New South Wales' },
  { id: 'ACT', label: 'Australian Capital Territory' },
  { id: 'SA', label: 'South Australia' },
  { id: 'WA', label: 'Western Australia' },
  { id: 'TAS', label: 'Tasmania' },
  { id: 'NT', label: 'Northern Territory' },
]

// A state's own pack, until which it's on the baseline. Step G2 adds to this.
const STATE_PACKS = { VIC: 'vic_rental', QLD: 'qld_electrical' }

/** The pack these answers start on, or null for a team that doesn't inspect. */
export function starterPackFor(tradeId, stateId) {
  if (tradeId === 'av') return 'av'
  if (tradeId !== 'electrical') return null
  return STATE_PACKS[stateId] ?? 'electrical_general'
}

/**
 * What can be chosen today. An inspecting team opens once its pack's lists have been
 * checked by a licensed electrician, which is when `proposed` comes off the pack. Teams
 * that receive reports opened at step D4, with their pages to land on.
 */
export const OPEN_NOW = { pack: pack => !pack.proposed, receiving: true }

export const stateIsOpen = (stateId, opening = OPEN_NOW) =>
  opening.pack(packById(starterPackFor('electrical', stateId)))

export function tradeIsOpen(trade, opening = OPEN_NOW) {
  if (trade.accountType !== 'provider') return opening.receiving
  if (trade.asksState) return STATES.some(state => stateIsOpen(state.id, opening))
  return opening.pack(packById(starterPackFor(trade.id)))
}
