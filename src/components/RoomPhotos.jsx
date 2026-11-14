import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import ConfirmDialog from './ConfirmDialog.jsx'
import UpgradeSheet from './UpgradeSheet.jsx'
import { IconClose, IconTrash } from './icons.jsx'
import { useAuth } from '../context/auth.js'
import { useEntitlements } from '../context/team.js'
import { entitledTeam, roomPhotoSheet, subscribeEntitlements } from '../lib/entitlements.js'
import {
  CAPTION_LIMIT,
  PHOTO_GROUPS,
  ROOM_PHOTO_LIMIT,
  addRoomPhoto,
  deleteRoomPhoto,
  listRoomPhotos,
  originalPhotoUrl,
  photoUrls,
  setRoomPhotoCaption,
  setRoomPhotoCategory,
} from '../lib/api.js'
import { flush, saveStatus, subscribe } from '../lib/cache.js'
import { classifySaveError } from '../lib/saveErrors.js'
import { fullQualityJpeg, shrinkPhoto } from '../lib/photo.js'

// Photos kept with a room (0022), in two groups: General, what the room looks
// like, and Issues. Each has a description and the date it was added. They
// belong to the room, not to a visit, so they show in the site's room editor and
// on the room during any visit, and a report of the site can carry them.
//
// Each photo goes up twice: a 1600 px copy for the screen and the PDF, and the
// best full-quality JPEG that fits the bucket, which Download hands back.
//
// Like a label photo (LabelPhoto.jsx): straight to the team's private photo
// folder, so it needs a connection, and the database has the last word. Only
// for a team that has room photos (entitlements.roomPhotos: switched on by
// M.D., or Pro once limits are on); for any other, and before 0022, there's no
// section at all.

const NEEDS_SIGNAL = 'Photos need a connection. Try again once you have signal.'
const OBSERVER = 'You\'re an observer in this team: you can see its photos, but not change them.'

const addedOn = iso =>
  new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
const localDay = iso => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const groupLabel = id => PHOTO_GROUPS.find(g => g.id === id)?.label ?? 'General'
const otherGroup = id => (id === 'issue' ? 'general' : 'issue')
// Characters Windows and iOS refuse in a filename.
const safe = s => String(s ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()

/** What a downloaded photo is called: "<client> <room> <group> <date>.jpg". */
const downloadName = (clientName, roomName, photo) =>
  `${[clientName, roomName || 'Room', groupLabel(photo.category), localDay(photo.takenAt)].map(safe).filter(Boolean).join(' ')}.jpg`

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

const smallButton =
  'border-hair text-navy min-h-[38px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50 disabled:opacity-50'

/** The photos themselves: shown open, as on the room during a visit. */
export default function RoomPhotos({ room, clientName = '' }) {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const entitlements = useEntitlements()
  const { session } = useAuth()
  const me = session?.user?.id ?? null
  const offline = useSyncExternalStore(subscribe, saveStatus) === 'offline'
  const allowed = !!teamId && entitlements?.roomPhotos === true
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
  const inputs = useRef({})
  const refresh = useCallback(() => setShown(n => n + 1), [])

  useEffect(() => {
    if (!allowed || !room?.id) return undefined
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
  }, [allowed, teamId, room?.id, shown])

  if (!allowed || !room?.id || photos === null) return null

  const inGroup = id => (photos ?? []).filter(p => p.category === id)
  const noSignal = () => offline || navigator.onLine === false
  const name = room.name || 'this room'

  const add = async (fileList, category) => {
    const files = [...(fileList ?? [])]
    // Cleared at once, so the same photo can be chosen again whatever happens.
    for (const input of Object.values(inputs.current)) if (input) input.value = ''
    setError('')
    setNote('')
    if (!files.length) return
    if (noSignal()) return setError(NEEDS_SIGNAL)
    const space = ROOM_PHOTO_LIMIT - inGroup(category).length
    const label = groupLabel(category)
    if (space <= 0) return setError(`${label} holds up to ${ROOM_PHOTO_LIMIT} photos. Delete or move one to add another.`)
    const take = files.slice(0, space)
    const notes = []
    if (files.length > take.length) {
      const left = files.length - take.length
      notes.push(`${left === 1 ? 'One photo wasn\'t' : `${left} photos weren't`} added: ${label} holds up to ${ROOM_PHOTO_LIMIT}.`)
    }
    let reduced = 0
    try {
      // The room's record has to be in the database before a photo can point at it.
      if (!(await flush())) return setError('This room hasn\'t saved yet. Try again once it has.')
      for (const [i, file] of take.entries()) {
        setBusy(take.length > 1 ? `Adding photo ${i + 1} of ${take.length}…` : 'Adding the photo…')
        const display = await shrinkPhoto(file)
        const original = display.ok ? await fullQualityJpeg(file) : display
        if (!display.ok || !original.ok) {
          notes.push(`${file.name || 'A file'}: ${(display.ok ? original : display).error}`)
          continue
        }
        try {
          await addRoomPhoto(teamId, room.id, { display: display.blob, original: original.blob }, category)
          if (original.reduced) reduced++
        } catch (e) {
          if (classifySaveError(e) === 'upgrade') setSheet(roomPhotoSheet())
          else setError(errorText(e, 'A photo wasn\'t saved'))
          return
        }
      }
    } catch (e) {
      setError(errorText(e, 'A photo wasn\'t saved'))
    } finally {
      if (reduced) {
        notes.push(`${reduced === 1 ? 'One photo was' : `${reduced} photos were`} too large to keep at full size, so the largest copy that fits was kept for download.`)
      }
      setBusy('')
      setNote(notes.join(' '))
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

  const move = async photo => {
    setError('')
    const to = otherGroup(photo.category)
    if (inGroup(to).length >= ROOM_PHOTO_LIMIT) return setError(`${groupLabel(to)} already holds ${ROOM_PHOTO_LIMIT} photos.`)
    if (noSignal()) return setError(NEEDS_SIGNAL)
    try {
      await setRoomPhotoCategory(photo.id, to)
      setPhotos(list => list?.map(p => (p.id === photo.id ? { ...p, category: to } : p)))
    } catch (e) {
      setError(errorText(e, 'The photo wasn\'t moved'))
    }
  }

  const download = async photo => {
    setError('')
    if (noSignal()) return setError(NEEDS_SIGNAL)
    try {
      const a = document.createElement('a')
      a.href = await originalPhotoUrl(photo, downloadName(clientName, room.name, photo))
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      setError(errorText(e, 'The photo couldn\'t be downloaded'))
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

  return (
    <section className="border-hair mb-4 rounded-xl border bg-white p-4" aria-label={`Photos of ${name}`}>
      <h3 className="text-[14px] font-bold">Photos</h3>
      {busy && <p className="text-ink-soft mt-2 text-[12.5px]">{busy}</p>}
      {error && (
        <p role="alert" className="text-fail mt-2 text-[12.5px] font-semibold">
          {error}
        </p>
      )}
      {note && <p className="text-ink-soft mt-2 text-[12.5px]">{note}</p>}
      {!canChange && <p className="text-ink-soft mt-2 text-[12.5px]">{OBSERVER}</p>}

      {PHOTO_GROUPS.map(group => {
        const list = inGroup(group.id)
        const full = list.length >= ROOM_PHOTO_LIMIT
        return (
          <div key={group.id} role="group" aria-label={`${group.label} photos of ${name}`} className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-[13.5px] font-semibold">
                {group.label}
                {photos !== undefined && (
                  <span className="text-ink-soft ml-2 text-[12px] font-normal">
                    {list.length} of {ROOM_PHOTO_LIMIT}
                  </span>
                )}
              </h4>
              {canChange && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={!!busy || full || photos === undefined}
                    onClick={() => inputs.current[`camera-${group.id}`]?.click()}
                    aria-label={`Take a photo for ${group.label}`}
                    className={smallButton}
                  >
                    Take a photo
                  </button>
                  <button
                    type="button"
                    disabled={!!busy || full || photos === undefined}
                    onClick={() => inputs.current[`gallery-${group.id}`]?.click()}
                    aria-label={`Choose photos for ${group.label}`}
                    className={smallButton}
                  >
                    Choose photos
                  </button>
                  <input
                    ref={el => (inputs.current[`camera-${group.id}`] = el)}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    aria-label={`Take a photo of ${name} for ${group.label}`}
                    className="hidden"
                    onChange={e => add(e.target.files, group.id)}
                  />
                  <input
                    ref={el => (inputs.current[`gallery-${group.id}`] = el)}
                    type="file"
                    accept="image/*"
                    multiple
                    aria-label={`Choose photos of ${name} for ${group.label}`}
                    className="hidden"
                    onChange={e => add(e.target.files, group.id)}
                  />
                </div>
              )}
            </div>

            {photos === undefined ? (
              <p className="text-ink-soft mt-2 text-[13px]">Loading photos…</p>
            ) : list.length === 0 ? (
              <p className="text-ink-soft mt-2 text-[13px]">None yet.</p>
            ) : (
              <ul className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {list.map(photo => (
                  <li key={photo.id} className="border-hair flex flex-col gap-2 rounded-lg border p-2">
                    <button
                      type="button"
                      onClick={() => setViewing(photo)}
                      className="block overflow-hidden rounded-md bg-slate-100"
                      aria-label={`View the photo added ${addedOn(photo.takenAt)} full size`}
                    >
                      {links[photo.path] ? (
                        <img src={links[photo.path]} alt={photo.caption || `Photo of ${name}`} className="aspect-[4/3] w-full object-cover" />
                      ) : (
                        <span className="text-ink-soft grid aspect-[4/3] place-items-center text-[12px]">No preview</span>
                      )}
                    </button>
                    <Caption key={photo.caption} photo={photo} readOnly={!canChange} onSave={saveCaption} />
                    <span className="text-ink-soft text-[12px]">
                      Added {addedOn(photo.takenAt)}
                      {who(photo) ? ` by ${who(photo)}` : ''}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {canChange && (
                        <button
                          type="button"
                          disabled={inGroup(otherGroup(photo.category)).length >= ROOM_PHOTO_LIMIT}
                          onClick={() => move(photo)}
                          className={smallButton}
                        >
                          Move to {groupLabel(otherGroup(photo.category))}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => download(photo)}
                        aria-label={`Download the photo added ${addedOn(photo.takenAt)} in full quality`}
                        className={smallButton}
                      >
                        Download
                      </button>
                      {canChange && (
                        <button
                          type="button"
                          onClick={() => setDeleting(photo)}
                          aria-label={`Delete the photo added ${addedOn(photo.takenAt)}`}
                          className="text-ink-soft hover:text-fail ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-lg hover:bg-red-50"
                        >
                          <IconTrash size={16} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}

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
              {groupLabel(viewing.category)} · Added {addedOn(viewing.takenAt)}
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
          It's removed from {name}, with its full-quality copy, and from any report made after this. Reports already sent keep it.
        </ConfirmDialog>
      )}
      {sheet && <UpgradeSheet sheet={sheet} onClose={() => setSheet(null)} />}
    </section>
  )
}

/**
 * In the site's room editor: a Photos button under each saved room, opening its
 * photos there. Only for a team that has room photos, and only for a room that
 * will be kept (one with a name or plan number: blank ones aren't).
 */
export function RoomPhotosToggle({ room, clientName }) {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const entitlements = useEntitlements()
  const [open, setOpen] = useState(false)
  const kept = String(room.name ?? '').trim() || String(room.planNumber ?? '').trim()
  if (!teamId || entitlements?.roomPhotos !== true || !kept) return null
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
          <RoomPhotos room={room} clientName={clientName} />
        </div>
      )}
    </div>
  )
}
