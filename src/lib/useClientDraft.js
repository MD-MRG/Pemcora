import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { saveClientLocation, saveFloors, locationKey, uid } from './clientStore.js'

// The client + location being built on the New Client page.
//
// Floors and rooms hang off a LOCATION, not a client — that is what lets one
// client have several sites without them sharing a room list.

const newRoom = () => ({ id: uid(), name: '', planNumber: '' })
const newFloor = () => ({ id: uid(), label: '', rooms: [newRoom()] })

// Ordered as an address is written, which is also the order they get typed.
const DETAIL_FIELDS = ['name', 'address', 'suburb', 'city', 'state', 'postcode']

const emptyDetails = () => Object.fromEntries(DETAIL_FIELDS.map(k => [k, '']))

export function useClientDraft() {
  const [details, setDetails] = useState(emptyDetails)
  const [floors, setFloors] = useState(() => [newFloor()])
  const [saved, setSaved] = useState(false)
  const [notice, setNotice] = useState(null) // { kind, clientName, existing }
  const [target, setTarget] = useState(null) // { clientId, locationId }
  const [saveState, setSaveState] = useState('idle')
  const [lastAdded, setLastAdded] = useState(null)

  // The exact name+address+suburb that was rejected as a duplicate. Save stays
  // disabled until one of those three changes — editing City, State or Postcode
  // is not enough, because they are not what makes a location distinct.
  const [blockedKey, setBlockedKey] = useState(null)

  const currentKey = locationKey(details.name, details.address, details.suburb)
  const isBlocked = blockedKey !== null && blockedKey === currentKey

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

  // Appends within the given floor only — a room must not land on floor 1 just
  // because that is where the list starts.
  const addRoom = useCallback(floorId => {
    const room = newRoom()
    setFloors(fs => fs.map(f => (f.id === floorId ? { ...f, rooms: [...f.rooms, room] } : f)))
    setLastAdded({ type: 'room', id: room.id })
  }, [])

  const addFloor = useCallback(() => {
    const floor = newFloor()
    setFloors(fs => [...fs, floor])
    setLastAdded({ type: 'floor', id: floor.id })
  }, [])

  const detailsComplete = useMemo(
    () => DETAIL_FIELDS.every(k => details[k].trim().length > 0),
    [details],
  )

  const totals = useMemo(
    () => ({ floors: floors.length, rooms: floors.reduce((n, f) => n + f.rooms.length, 0) }),
    [floors],
  )

  const canSave = detailsComplete && !isBlocked

  const saveClient = useCallback(() => {
    if (!canSave) return
    const result = saveClientLocation(details)

    if (result.outcome === 'duplicate') {
      // Nothing was written. Hold the rejected combination so the button stays
      // disabled until the technician changes something that matters.
      setBlockedKey(currentKey)
      setNotice({ kind: 'duplicate', existing: result.existing, clientName: details.name.trim() })
      return
    }

    setBlockedKey(null)
    setTarget({ clientId: result.clientId, locationId: result.locationId })
    setNotice(
      result.outcome === 'location-added'
        ? { kind: 'location-added', clientName: details.name.trim() }
        : null,
    )
    setSaveState('saved')
    setSaved(true)
  }, [canSave, details, currentKey])

  // Autosave floors and rooms to the saved location, debounced.
  const timer = useRef(null)
  const floorsRef = useRef(floors)
  useEffect(() => {
    floorsRef.current = floors
  }, [floors])

  useEffect(() => {
    if (!saved || !target) return
    setSaveState('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const ok = saveFloors(target.clientId, target.locationId, floorsRef.current)
      setSaveState(ok ? 'saved' : 'error')
    }, 500)
    return () => clearTimeout(timer.current)
  }, [floors, saved, target])

  // Write immediately — used by Finished, so nothing is lost to the debounce.
  const flush = useCallback(() => {
    if (!saved || !target) return
    clearTimeout(timer.current)
    const ok = saveFloors(target.clientId, target.locationId, floorsRef.current)
    setSaveState(ok ? 'saved' : 'error')
  }, [saved, target])

  return {
    details,
    floors,
    saved,
    notice,
    target,
    saveState,
    lastAdded,
    detailsComplete,
    isBlocked,
    canSave,
    totals,
    setField,
    setFloorLabel,
    setRoom,
    addRoom,
    addFloor,
    saveClient,
    flush,
  }
}
