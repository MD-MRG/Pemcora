import { useState } from 'react'
import Notice from './Notice.jsx'
import PackPicker from './PackPicker.jsx'
import { useCanManage, useEntitlements } from '../context/team.js'
import { packById } from '../data/packs/index.js'
import { swapStarterPack, swapTargets } from '../lib/entitlements.js'

/**
 * For a team that took the wrong pack at sign-up (build plan 2.3). The upgrade sheet
 * can't help them: it only appears on a page of a pack they don't hold, and those
 * pages are hidden. Owners and admins, and only for as long as it can still be
 * swapped, so a team with nothing to change never sees it.
 */
export default function StarterPackCard() {
  const entitlements = useEntitlements()
  const canManage = useCanManage()
  const [choice, setChoice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  const targets = swapTargets(entitlements)
  if (!canManage || targets.length === 0) return null
  const chosen = targets.some(pack => pack.id === choice) ? choice : null

  return (
    <section className="border-hair rounded-xl border bg-white p-6">
      <h2 className="text-[19px] font-bold tracking-[-.01em]">Your pack</h2>
      <p className="text-ink-soft mt-1 max-w-[62ch] text-[14px]">
        <b>{packById(entitlements.starterPack)?.label}</b> is this team's starter pack. It can be
        changed until the team starts its first visit under it. After that, another kind of
        inspection means adding a pack.
      </p>
      <div className="mt-4 max-w-md">
        <PackPicker label="Change it to" packs={targets} value={chosen} onChange={setChoice} />
      </div>
      {problem && (
        <div className="mt-3">
          <Notice blocked title={problem} />
        </div>
      )}
      <button
        type="button"
        disabled={!chosen || busy}
        onClick={async () => {
          setBusy(true)
          setProblem('')
          try {
            await swapStarterPack(chosen)
            setChoice(null)
          } catch (e) {
            setProblem(e.message)
          }
          setBusy(false)
        }}
        className="bg-navy mt-4 min-h-[46px] rounded-lg px-5 text-[13.5px] font-semibold text-white hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-55"
      >
        {busy ? 'Working…' : 'Change pack'}
      </button>
    </section>
  )
}
