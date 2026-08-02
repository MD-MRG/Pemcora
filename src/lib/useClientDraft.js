import { useState, useCallback, useMemo } from 'react'

// The client being built on the New Client page.
//
// Shape is deliberate: the eventual database schema mirrors it, so wiring
// persistence later is a straight mapping rather than a reshape.
//
//   { name, address, suburb, city, state, postcode,
//     floors: [ { id, label, rooms: [ { id, name, planNumber } ] } ] }

const uid = () => crypto.randomUUID()
const newRoom = () => ({ id: uid(), name: '', planNumber: '' })
const newFloor = () => ({ id: uid(), label: '', rooms: [newRoom()] })

// Ordered as an address is written, which is also the order they get typed.
const DETAIL_FIELDS = ['name', 'address', 'suburb', 'city', 'state', 'postcode']

const emptyDetails = () =>
  Object.fromEntries(DETAIL_FIELDS.map(k => [k, '']))

export function useClientDraft() {
  const [details, setDetails] = useState(emptyDetails)
  const [floors, setFloors] = useState(() => [newFloor()])
  const [saved, setSaved] = useState(false)

  // Ids of the entries added by the last action, so the page can move focus there.
  const [lastAdded, setLastAdded] = useState(null)

  const setField = useCallback((key, value) => {
    setDetails(d => ({ ...d, [key]: value }))
  }, [])

  const setFloorLabel = useCallback((floorId, label) => {
    setFloors(fs => fs.map(f => (f.id === floorId ? { ...f, label } : f)))
  }, [])

  const setRoom = useCallback((floorId, roomId, key, value) => {
    setFloors(fs =>
      fs.map(f =>
        f.id === floorId
          ? { ...f, rooms: f.rooms.map(r => (r.id === roomId ? { ...r, [key]: value } : r)) }
          : f,
      ),
    )
  }, [])

  // Appends within the given floor only — the room must not land on floor 1
  // just because that is where the list starts.
  const addRoom = useCallback(floorId => {
    const room = newRoom()
    setFloors(fs =>
      fs.map(f => (f.id === floorId ? { ...f, rooms: [...f.rooms, room] } : f)),
    )
    setLastAdded({ type: 'room', id: room.id })
  }, [])

  const addFloor = useCallback(() => {
    const floor = newFloor()
    setFloors(fs => [...fs, floor])
    setLastAdded({ type: 'floor', id: floor.id })
  }, [])

  // Every detail field is required before a client can be saved.
  const detailsComplete = useMemo(
    () => DETAIL_FIELDS.every(k => details[k].trim().length > 0),
    [details],
  )

  const totals = useMemo(
    () => ({
      floors: floors.length,
      rooms: floors.reduce((n, f) => n + f.rooms.length, 0),
    }),
    [floors],
  )

  // Persistence seam. There is no backend yet, so this deliberately does
  // nothing and the page shows no save indicator — reporting "Saved" while
  // nothing is stored would be worse than showing nothing at all.
  // When Supabase arrives, this is the only function that changes.
  const persist = useCallback(() => {}, [])

  const saveClient = useCallback(() => {
    if (!detailsComplete) return
    persist()
    setSaved(true)
  }, [detailsComplete, persist])

  return {
    details,
    floors,
    saved,
    lastAdded,
    detailsComplete,
    totals,
    setField,
    setFloorLabel,
    setRoom,
    addRoom,
    addFloor,
    saveClient,
    persist,
  }
}
