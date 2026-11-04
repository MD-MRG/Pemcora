// The rooms of a home, which is how the electrical and smoke alarm rules are
// written: "an alarm in every bedroom", "in the hallway serving them".
//
// The key is what a room stores (rooms.room_type) and what a section's
// `roomTypes` and a template's `coverage` rules name, so it never changes once a
// pack has shipped. The label can.
//
// Proposed with the packs that use it. A licensed electrician checks it with the
// lists.

export const HOME_ROOM_TYPES = [
  { id: 'bedroom', label: 'Bedroom' },
  { id: 'hallway', label: 'Hallway' },
  { id: 'living', label: 'Living area' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'bathroom', label: 'Bathroom or ensuite' },
  { id: 'laundry', label: 'Laundry' },
  { id: 'garage', label: 'Garage' },
  { id: 'stairway', label: 'Stairway' },
  { id: 'other', label: 'Other' },
]
