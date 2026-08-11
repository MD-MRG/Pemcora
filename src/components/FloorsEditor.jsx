import { useEffect, useRef, useState } from 'react'
import Field from './Field.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import { IconTrash } from './icons.jsx'

// Floors and their rooms, shared by New Client and Edit Client so the two can't
// drift apart. Each floor owns its New Room button; one Another floor sits at
// the end, as specified.

export function AddButton({ onClick, children, tone = 'soft' }) {
  const styles =
    tone === 'strong'
      ? 'border-navy/25 bg-navy/5 text-navy hover:bg-navy/10'
      : 'border-hair bg-white text-navy hover:bg-slate-50'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[46px] w-full rounded-lg border border-dashed px-4 text-[13.5px] font-semibold transition-colors ${styles}`}
    >
      + {children}
    </button>
  )
}

function FloorBlock({ floor, index, setFloorLabel, setRoom, addRoom, removeRoom, registerRef }) {
  return (
    <section className="border-hair rounded-xl border bg-white p-4 shadow-sm">
      <Field
        label={`Floor ${index + 1}`}
        value={floor.label}
        onChange={v => setFloorLabel(floor.id, v)}
        placeholder="e.g. Level 47"
        inputRef={registerRef('floor', floor.id)}
      />

      <div className="mt-4 flex flex-col gap-3">
        {floor.rooms.map((room, ri) => (
          <div key={room.id} className="flex items-end gap-2">
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
              <Field
                label={ri === 0 ? 'Room' : ''}
                aria-label={`Floor ${index + 1} room ${ri + 1} name`}
                value={room.name}
                onChange={v => setRoom(floor.id, room.id, 'name', v)}
                placeholder="Room name"
                inputRef={registerRef('room', room.id)}
              />
              <Field
                label={ri === 0 ? 'Floor plan no.' : ''}
                aria-label={`Floor ${index + 1} room ${ri + 1} plan number`}
                value={room.planNumber}
                onChange={v => setRoom(floor.id, room.id, 'planNumber', v)}
                placeholder="Plan number"
              />
            </div>
            {/* Only where a caller asked for it. New Client deliberately has no
                delete controls — you are building the plan, and the way to undo
                a room you have not saved is to leave it blank. Its suite
                asserts their absence. */}
            {removeRoom && (
              <button
                type="button"
                onClick={() => removeRoom(floor.id, room)}
                aria-label={`Delete floor ${index + 1} room ${ri + 1}`}
                className="text-ink-soft hover:text-fail mb-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg hover:bg-red-50"
              >
                <IconTrash size={18} />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3">
        <AddButton onClick={() => addRoom(floor.id)}>New Room</AddButton>
      </div>
    </section>
  )
}

export default function FloorsEditor({
  floors,
  lastAdded,
  setFloorLabel,
  setRoom,
  addRoom,
  removeRoom,
  addFloor,
}) {
  // Confirm only a room that holds something. The page always shows an empty
  // room to type into, and making someone confirm the removal of a blank they
  // just added is friction with nothing behind it.
  const [pending, setPending] = useState(null)
  const askRemove = !removeRoom ? undefined : (floorId, room) => {
    const empty = !String(room.name ?? '').trim() && !String(room.planNumber ?? '').trim()
    if (empty) removeRoom(floorId, room.id)
    else setPending({ floorId, room })
  }
  // Focus whatever was just added, so a run of rooms is typed rather than hunted.
  const refs = useRef(new Map())
  const registerRef = (kind, id) => el => {
    if (el) refs.current.set(`${kind}:${id}`, el)
    else refs.current.delete(`${kind}:${id}`)
  }
  useEffect(() => {
    if (!lastAdded) return
    refs.current.get(`${lastAdded.type}:${lastAdded.id}`)?.focus()
  }, [lastAdded])

  return (
    <div className="flex flex-col gap-4">
      {floors.map((floor, i) => (
        <FloorBlock
          key={floor.id}
          floor={floor}
          index={i}
          setFloorLabel={setFloorLabel}
          setRoom={setRoom}
          addRoom={addRoom}
          removeRoom={askRemove}
          registerRef={registerRef}
        />
      ))}
      <AddButton tone="strong" onClick={addFloor}>
        Another floor
      </AddButton>

      {pending && (
        <ConfirmDialog
          danger
          title={`Delete "${pending.room.name || 'this room'}"?`}
          confirmLabel="Delete room"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            removeRoom(pending.floorId, pending.room.id)
            setPending(null)
          }}
        >
          It is removed from this location's floor plan. Results already recorded against it in past
          visits are kept, but it will no longer appear on a report regenerated from them.
        </ConfirmDialog>
      )}
    </div>
  )
}
