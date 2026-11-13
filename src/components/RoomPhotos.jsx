import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import ConfirmDialog from './ConfirmDialog.jsx'
import UpgradeSheet from './UpgradeSheet.jsx'
import { IconClose, IconTrash } from './icons.jsx'
import { useAuth } from '../context/auth.js'
import { useEntitlements } from '../context/team.js'
import { entitledTeam, roomPhotoSheet, subscribeEntitlements } from '../lib/entitlements.js'
import {
  CAPTION_LIMIT,
  ROOM_PHOTO_LIMIT,
  addRoomPhoto,
  deleteRoomPhoto,
  listRoomPhotos,
  photoUrls,
  roomPhotosReady,
  setRoomPhotoCaption,
} from '../lib/api.js'
import { flush, saveStatus, subscribe } from '../lib/cache.js'
import { classifySaveError } from '../lib/saveErrors.js'
import { shrinkPhoto } from '../lib/photo.js'

// Photos kept with a room (0022): what it looks like, each with a description
// and the date it was added. They belong to the room, not to a visit, so they
// show in the site's room editor and on the room during any visit, and every
// report of the site carries them.
//
// Like a label photo (LabelPhoto.jsx): straight to the team's private photo
// folder, so it needs a connection; the plan is checked by the database, and a
// refusal gets the upgrade sheet (2.11). Hidden until the database has room
// photos (0022 applied), and with no signed-in team.

const NEEDS_SIGNAL = 'Photos need a connection. Try again once you have signal.'
const OBSERVER = 'You\'re an observer in this team: you can see its photos, but not change them.'

const addedOn = iso =>
  new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })

// One check per team per page load: is 0022 there? A room editor asks it once,
// not once for every room.
const ready = new Map()
const isReady = teamId => {
  if (!ready.has(teamId)) {
    ready.set(teamId, roomPhotosReady(teamId).catch(e => {
      ready.delete(teamId)
      throw e
    }))
  }
  return ready.get(teamId)
}

function errorText(e, what) {
  const reason = classifySaveError(e)
  if (reason === 'network') return NEEDS_SIGNAL
  if (e?.hint === 'observer') return OBSERVER
  if (reason === 'gone') return 'This room hasn\'t saved yet, or has been deleted. Try again once it has saved.'
  return `${what}: ${e?.message ?? 'something went wrong'}.`
}

/** A photo's description: typed freely, saved when the box is left. */
function Caption({ photo, readOnly, onSave }) {
  const [text, setText] = useState(photo.caption)
  const saved = useRef(photo.caption)
  return (
    <textarea
      rows={2}
      value={text}
      maxLength={CAPTION_LIMIT}
      readOnly={readOnly}
      onChange={e => setText(e.target.value)}
      onBlur={async () => {
        if (readOnly || text === saved.current) return
        if (await onSave(photo, text)) saved.current = text
      }}
      placeholder={readOnly ? 'No description' : 'Describe what this shows'}
      aria-label={`Description of the photo added ${addedOn(photo.takenAt)}`}
      className="border-hair text-ink focus:border-navy w-full resize-y rounded-lg border px-2.5 py-1.5 text-[13px] outline-none read-only:bg-slate-50"
    />
  )
}

/** The photos themselves: shown open, as on the room during a visit. */
export default function RoomPhotos({ room }) {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const entitlements = useEntitlements()
  const { session } = useAuth()
  const me = session?.user?.id ?? null
  const offline = useSyncExternalStore(subscribe, saveStatus) === 'offline'
  // An observer (Phase E: no seat) sees the photos but can't change them.
  const canChange = entitlements?.worker !== false

  const [photos, setPhotos] = useState(undefined) // undefined loading, null no room photos yet
  const [links, setLinks] = useState({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [sheet, setSheet] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [shown, setShown] = useState(0)
  const camera = useRef(null)
  const gallery = useRef(null)
  const refresh = useCallback(() => setShown(n => n + 1), [])

  useEffect(() => {
    if (!teamId || !room?.id) return undefined
    let alive = true
    listRoomPhotos(teamId, room.id)
      .then(async list => {
        const urls = list?.length ? await photoUrls(list.map(p => p.path)).catch(() => ({})) : {}
        if (!alive) return
        setPhotos(list)
        setLinks(urls)
      })
      .catch(e => {
        if (!alive) return
        setPhotos(p => p ?? [])
        setError(classifySaveError(e) === 'network' ? NEEDS_SIGNAL : 'The photos couldn\'t be loaded.')
      })
    return () => {
      alive = false
    }
  }, [teamId, room?.id, shown])

  if (!teamId || !room?.id || photos === null) return null

  const count = photos?.length ?? 0
  const full = count >= ROOM_PHOTO_LIMIT
  const noSignal = () => offline || navigator.onLine === false

  const add = async fileList => {
    const files = [...(fileList ?? [])]
    setError('')
    setNote('')
    if (!files.length) return
    if (noSignal()) return setError(NEEDS_SIGNAL)
    const space = ROOM_PHOTO_LIMIT - count
    if (space <= 0) return setError(`A room holds up to ${ROOM_PHOTO_LIMIT} photos. Delete one to add another.`)
    const take = files.slice(0, space)
    const skipped = []
    if (files.length > take.length) {
      skipped.push(`${files.length - take.length === 1 ? 'One photo wasn\'t' : `${files.length - take.length} photos weren't`} added: a room holds up to ${ROOM_PHOTO_LIMIT}.`)
    }
    try {
      // The room's record has to be in the database before a photo can point at it.
      if (!(await flush())) return setError('This room hasn\'t saved yet. Try again once it has.')
      for (const [i, file] of take.entries()) {
        setBusy(take.length > 1 ? `Adding photo ${i + 1} of ${take.length}…` : 'Adding the photo…')
        const small = await shrinkPhoto(file)
        if (!small.ok) {
          skipped.push(`${file.name || 'A file'}: ${small.error}`)
          continue
        }
        try {
          await addRoomPhoto(teamId, room.id, small.blob)
        } catch (e) {
          if (classifySaveError(e) === 'upgrade') {
            setSheet(roomPhotoSheet())
            return
          }
          setError(errorText(e, 'A photo wasn\'t saved'))
          return
        }
      }
    } finally {
      setBusy('')
      setNote(skipped.join(' '))
      if (camera.current) camera.current.value = ''
      if (gallery.current) gallery.current.value = ''
      refresh()
    }
  }

  const saveCaption = async (photo, text) => {
    setError('')
    if (noSignal()) {
      setError(NEEDS_SIGNAL)
      return false
    }
    try {
      await setRoomPhotoCaption(photo.id, text)
      const caption = text.slice(0, CAPTION_LIMIT)
      setPhotos(list => list?.map(p => (p.id === photo.id ? { ...p, caption } : p)))
      setViewing(v => (v?.id === photo.id ? { ...v, caption } : v))
      return true
    } catch (e) {
      setError(errorText(e, 'The description wasn\'t saved'))
      return false
    }
  }

  const remove = async photo => {
    setDeleting(null)
    setError('')
    if (noSignal()) return setError(NEEDS_SIGNAL)
    try {
      await deleteRoomPhoto(photo)
      if (viewing?.id === photo.id) setViewing(null)
    } catch (e) {
      setError(errorText(e, 'The photo wasn\'t deleted'))
    } finally {
      refresh()
    }
  }

  const who = photo => (photo.createdBy && photo.createdBy === me ? 'you' : photo.uploader)
  const name = room.name || 'this room'

  return (
    <section className="border-hair mb-4 rounded-xl border bg-white p-4" aria-label={`Photos of ${name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-bold">
          Photos
          {entitlements?.enforced && !entitlements.isPro && (
            <span className="bg-navy/10 text-navy ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold">Pro</span>
          )}
          {photos !== undefined && (
            <span className="text-ink-soft ml-2 text-[12px] font-normal">
              {count} of {ROOM_PHOTO_LIMIT}
            </span>
          )}
        </h3>
        {canChange && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!!busy || full || photos === undefined}
              onClick={() => camera.current?.click()}
              className="border-hair text-navy min-h-[38px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50 disabled:opacity-50"
            >
              Take a photo
            </button>
            <button
              type="button"
              disabled={!!busy || full || photos === undefined}
              onClick={() => gallery.current?.click()}
              className="border-hair text-navy min-h-[38px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50 disabled:opacity-50"
            >
              Choose photos
            </button>
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              aria-label={`Take a photo of ${name}`}
              className="hidden"
              onChange={e => add(e.target.files)}
            />
            <input
              ref={gallery}
              type="file"
              accept="image/*"
              multiple
              aria-label={`Choose photos of ${name}`}
              className="hidden"
              onChange={e => add(e.target.files)}
            />
          </div>
        )}
      </div>

      {busy && <p className="text-ink-soft mt-2 text-[12.5px]">{busy}</p>}
      {error && (
        <p role="alert" className="text-fail mt-2 text-[12.5px] font-semibold">
          {error}
        </p>
      )}
      {note && <p className="text-ink-soft mt-2 text-[12.5px]">{note}</p>}
      {!canChange && <p className="text-ink-soft mt-2 text-[12.5px]">{OBSERVER}</p>}

      {photos === undefined ? (
        <p className="text-ink-soft mt-3 text-[13px]">Loading photos…</p>
      ) : count === 0 ? (
        <p className="text-ink-soft mt-3 text-[13px]">No photos of this room yet.</p>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {photos.map(photo => (
            <li key={photo.id} className="border-hair flex flex-col gap-2 rounded-lg border p-2">
              <button
                type="button"
                onClick={() => setViewing(photo)}
                className="block overflow-hidden rounded-md bg-slate-100"
                aria-label={`View the photo added ${addedOn(photo.takenAt)} full size`}
              >
                {links[photo.path] ? (
                  <img
                    src={links[photo.path]}
                    alt={photo.caption || `Photo of ${name}`}
                    className="aspect-[4/3] w-full object-cover"
                  />
                ) : (
                  <span className="text-ink-soft grid aspect-[4/3] place-items-center text-[12px]">No preview</span>
                )}
              </button>
              <Caption key={photo.caption} photo={photo} readOnly={!canChange} onSave={saveCaption} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-soft text-[12px]">
                  Added {addedOn(photo.takenAt)}
                  {who(photo) ? ` by ${who(photo)}` : ''}
                </span>
                {canChange && (
                  <button
                    type="button"
                    onClick={() => setDeleting(photo)}
                    aria-label={`Delete the photo added ${addedOn(photo.takenAt)}`}
                    className="text-ink-soft hover:text-fail grid h-9 w-9 shrink-0 place-items-center rounded-lg hover:bg-red-50"
                  >
                    <IconTrash size={16} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {viewing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Photo of ${name}`}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-4"
          onClick={() => setViewing(null)}
          onKeyDown={e => e.key === 'Escape' && setViewing(null)}
        >
          <button
            type="button"
            autoFocus
            onClick={() => setViewing(null)}
            aria-label="Close the photo"
            className="absolute top-3 right-3 grid h-11 w-11 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <IconClose size={22} />
          </button>
          {links[viewing.path] && (
            <img
              src={links[viewing.path]}
              alt={viewing.caption || `Photo of ${name}`}
              className="max-h-[80vh] max-w-full rounded-md object-contain"
              onClick={e => e.stopPropagation()}
            />
          )}
          <p className="max-w-2xl text-center text-[13.5px] text-white" onClick={e => e.stopPropagation()}>
            {viewing.caption && <span className="block">{viewing.caption}</span>}
            <span className="text-white/70">
              Added {addedOn(viewing.takenAt)}
              {who(viewing) ? ` by ${who(viewing)}` : ''}
            </span>
          </p>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          danger
          title="Delete this photo?"
          confirmLabel="Delete photo"
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove(deleting)}
        >
          It's removed from {name} and from any report made after this. Reports already sent keep it.
        </ConfirmDialog>
      )}
      {sheet && <UpgradeSheet sheet={sheet} onClose={() => setSheet(null)} />}
    </section>
  )
}

/**
 * In the site's room editor: a Photos button under each saved room, opening its
 * photos there. Shown only once the database has room photos, and only for a
 * room that will be kept (one with a name or plan number: blank ones aren't).
 */
export function RoomPhotosToggle({ room }) {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const [available, setAvailable] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!teamId) return undefined
    let alive = true
    isReady(teamId).then(
      yes => alive && setAvailable(yes),
      () => alive && setAvailable(false),
    )
    return () => {
      alive = false
    }
  }, [teamId])

  const kept = String(room.name ?? '').trim() || String(room.planNumber ?? '').trim()
  if (!teamId || !available || !kept) return null
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="text-navy text-[12.5px] font-semibold hover:underline"
      >
        {open ? 'Hide photos' : `Photos of ${room.name || 'this room'}`}
      </button>
      {open && (
        <div className="mt-2">
          <RoomPhotos room={room} />
        </div>
      )}
    </div>
  )
}
