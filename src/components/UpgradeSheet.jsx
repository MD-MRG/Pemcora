import { useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog.jsx'
import { useCanManage, useTeam } from '../context/team.js'
import { listMembers } from '../lib/api.js'
import { startUpgrade, swapStarterPack } from '../lib/entitlements.js'

/**
 * What a plan refusal gets instead of an error (build plan 2.11). `sheet` comes from
 * entitlements.js, which holds the wording. Only owners and admins can do anything
 * about it. Everyone else is told who can, or generally who with no signal.
 */
export default function UpgradeSheet({ sheet, onClose }) {
  const { team } = useTeam()
  const canManage = useCanManage()
  const [admins, setAdmins] = useState([])
  const [note, setNote] = useState('')

  useEffect(() => {
    if (canManage || !team) return undefined
    let alive = true
    listMembers(team.id)
      .then(members => {
        if (!alive) return
        const owners = members.filter(m => m.role === 'owner')
        const others = members.filter(m => m.role === 'admin')
        setAdmins([...owners, ...others].map(m => m.email))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [canManage, team])

  return (
    <ConfirmDialog
      title={sheet.title}
      confirmLabel={canManage ? sheet.action : null}
      cancelLabel={canManage ? 'Not now' : 'Close'}
      onCancel={onClose}
      onConfirm={async () => {
        const { outcome } = await startUpgrade()
        if (outcome === 'not-yet') setNote('Upgrading isn\'t available yet.')
      }}
    >
      {sheet.lines.map(line => (
        <p key={line} className="mb-2">
          {line}
        </p>
      ))}
      {sheet.adds.length > 0 && (
        <>
          <p className="text-ink mt-3 font-semibold">Pro adds:</p>
          <ul className="mt-1 list-disc pl-5">
            {sheet.adds.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {sheet.kept && <p className="mt-3">{sheet.kept}</p>}
      {canManage && sheet.swap && (
        <div className="border-hair mt-3 rounded-lg border p-3">
          <p>{sheet.swap.line}</p>
          <button
            type="button"
            onClick={async () => {
              setNote('')
              try {
                await swapStarterPack(sheet.swap.packId)
                onClose()
              } catch (e) {
                setNote(e.message)
              }
            }}
            className="border-hair text-navy mt-2 min-h-[42px] rounded-lg border bg-white px-4 text-[13.5px] font-semibold hover:bg-slate-50"
          >
            {sheet.swap.action}
          </button>
        </div>
      )}
      {!canManage && (
        <p className="text-ink mt-3 font-semibold">
          {admins.length
            ? `Ask ${admins.join(' or ')} ${sheet.ask}.`
            : `Ask your team's owner or an admin ${sheet.ask}.`}
        </p>
      )}
      {note && <p className="text-fail mt-3 font-semibold">{note}</p>}
    </ConfirmDialog>
  )
}
