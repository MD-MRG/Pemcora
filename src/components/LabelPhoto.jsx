import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import UpgradeSheet from './UpgradeSheet.jsx'
import { useEntitlements } from '../context/team.js'
import { entitledTeam, photoSheet, subscribeEntitlements } from '../lib/entitlements.js'
import { addAssetPhoto, listAssetPhotos, photoUrl } from '../lib/api.js'
import { flush, saveStatus, subscribe } from '../lib/cache.js'
import { classifySaveError } from '../lib/saveErrors.js'
import { shrinkPhoto } from '../lib/photo.js'

// A photo of an item's label, on Pro (build plan C2). It goes straight to the
// team's private photo folder, so it needs a connection: everything else about
// the item saves offline as usual. Only for an item already added, which the
// photo's record has to point at.
//
// The plan is checked where it's enforced, by the database, and a refusal gets
// the upgrade sheet (2.11). The app only says up front that photos are Pro.
export default function LabelPhoto({ asset, name }) {
  const teamId = useSyncExternalStore(subscribeEntitlements, entitledTeam)
  const entitlements = useEntitlements()
  const offline = useSyncExternalStore(subscribe, saveStatus) === 'offline'
  const [photo, setPhoto] = useState(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sheet, setSheet] = useState(null)
  const [shown, setShown] = useState(0)
  const input = useRef(null)

  useEffect(() => {
    if (!teamId) return undefined
    let alive = true
    listAssetPhotos(teamId, asset.id)
      .then(async photos => {
        const latest = photos[0] ?? null
        const link = latest ? await photoUrl(latest.path) : ''
        if (!alive) return
        setPhoto(latest)
        setUrl(link)
      })
      .catch(e => {
        if (alive && classifySaveError(e) !== 'network') setError('The photo couldn\'t be loaded.')
      })
    return () => {
      alive = false
    }
  }, [teamId, asset.id, shown])

  if (!teamId) {
    return <p className="text-ink-soft text-[12.5px]">Label photos are kept with a signed-in team.</p>
  }

  const upload = async file => {
    setError('')
    if (!file) return
    if (offline || navigator.onLine === false) return setError('Adding a photo needs a connection. Try again once you have signal.')
    setBusy(true)
    try {
      const small = await shrinkPhoto(file)
      if (!small.ok) return setError(small.error)
      // The item's record has to be in the database before a photo can point at it.
      if (!(await flush())) return setError('This item hasn\'t saved yet. Try again once it has.')
      await addAssetPhoto(teamId, asset.id, small.blob)
      setShown(n => n + 1)
    } catch (e) {
      const reason = classifySaveError(e)
      if (reason === 'upgrade') setSheet(photoSheet())
      else if (reason === 'network') setError('Adding a photo needs a connection. Try again once you have signal.')
      else setError(`The photo wasn't saved: ${e?.message ?? 'something went wrong'}.`)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="border-hair rounded-lg border bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ink-soft text-[12.5px] font-semibold">
          Label photo
          {entitlements?.enforced && !entitlements.isPro && (
            <span className="bg-navy/10 text-navy ml-2 rounded-full px-2 py-0.5 text-[11px]">Pro</span>
          )}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="border-hair text-navy min-h-[38px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? 'Saving the photo…' : photo ? 'Replace label photo' : 'Add label photo'}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          aria-label={`Label photo of ${name}`}
          className="hidden"
          onChange={e => upload(e.target.files?.[0])}
        />
      </div>
      {url && (
        <img
          src={url}
          alt={`Label of ${name}`}
          className="border-hair mt-2 max-h-40 rounded-md border object-contain"
        />
      )}
      {photo && <p className="text-ink-soft mt-1 text-[12px]">Taken {new Date(photo.takenAt).toLocaleDateString()}</p>}
      {error && (
        <p role="alert" className="text-fail mt-2 text-[12.5px] font-semibold">
          {error}
        </p>
      )}
      {sheet && <UpgradeSheet sheet={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}
