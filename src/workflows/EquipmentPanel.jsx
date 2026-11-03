import { useState } from 'react'
import ItemForm from '../components/ItemForm.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import LabelPhoto from '../components/LabelPhoto.jsx'
import { addAsset, listAssets, removeAsset, replaceAsset, updateAsset } from '../lib/clientStore.js'
import { assetTypeLabel, assetTypeNoun, assetTypePlural } from '../data/packs/shared/assetTypes.js'
import { expiryState, itemName, itemSummary, replacementOf, showDate } from '../lib/equipment.js'

// The equipment at a site (build plan C2), on the site's page in each workflow
// whose list tests items one by one. Items belong to the site, so this is the
// same list whichever visit is open, or none. A removed item stays on record
// under "Removed", since the reports that tested it still name it. Replacing one
// removes it and adds the new one in its place.
//
//   types   the item types the workflow's list tests, in its order
export default function EquipmentPanel({ client, location, rooms, types, onChanged }) {
  // { id } editing an item, { replace: id } replacing it, or { assetType } adding one.
  const [open, setOpen] = useState(null)
  const [askRemove, setAskRemove] = useState(null)
  const [showRemoved, setShowRemoved] = useState({})
  const assets = listAssets(client.id, location.id)
  const roomName = id => rooms.find(r => r.id === id)?.name

  const form = (asset, saveLabel, onSave, extra = {}) => (
    <ItemForm asset={asset} rooms={rooms} saveLabel={saveLabel} onCancel={() => setOpen(null)} onSave={onSave} {...extra} />
  )
  const done = () => {
    setOpen(null)
    onChanged()
  }
  const SIDE = 'border-hair min-h-[40px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50'

  return (
    <section className="border-hair mb-4 overflow-hidden rounded-xl border bg-white" aria-label="Equipment">
      <h3 className="border-hair text-ink-soft border-b bg-slate-50 px-4 py-2.5 text-[11.5px] font-semibold tracking-[.08em] uppercase">
        Equipment
      </h3>
      {types.map(type => {
        const current = assets.filter(a => a.assetType === type && !a.removedAt)
        const removed = assets.filter(a => a.assetType === type && a.removedAt)
        return (
          <div key={type} className="border-hair border-b last:border-0" role="group" aria-label={assetTypePlural(type)}>
            <h4 className="text-ink px-4 pt-3 pb-1 text-[13.5px] font-bold">
              {heading(type)} <span className="text-ink-soft font-medium">({current.length})</span>
            </h4>
            {current.length === 0 && (
              <p className="text-ink-soft px-4 pb-2 text-[13px]">No {assetTypePlural(type)} recorded at this site yet.</p>
            )}
            <ul className="m-0 list-none p-0">
              {current.map((asset, i) =>
                open?.id === asset.id ? (
                  <li key={asset.id}>
                    {form(
                      asset,
                      'Save',
                      patch => {
                        updateAsset(client.id, location.id, asset.id, patch)
                        done()
                      },
                      {
                        footer: <LabelPhoto asset={asset} name={itemName(asset, i)} />,
                        children: (
                          <>
                            <button type="button" onClick={() => setOpen({ replace: asset.id })} className={`${SIDE} text-navy`}>
                              Replace
                            </button>
                            <button type="button" onClick={() => setAskRemove({ asset, name: itemName(asset, i) })} className={`${SIDE} text-fail`}>
                              Remove
                            </button>
                          </>
                        ),
                      },
                    )}
                  </li>
                ) : open?.replace === asset.id ? (
                  <li key={asset.id}>
                    <p className="border-hair border-t px-4 pt-3 text-[13.5px] font-semibold">
                      Replacing {itemName(asset, i)}. Enter the new {assetTypeNoun(type)}'s details.
                    </p>
                    {form(
                      { assetType: type, label: asset.label, roomId: asset.roomId },
                      'Replace',
                      patch => {
                        replaceAsset(client.id, location.id, asset.id, patch)
                        done()
                      },
                      { name: `Replace ${itemName(asset, i)}` },
                    )}
                  </li>
                ) : (
                  <li key={asset.id}>
                    <button
                      type="button"
                      onClick={() => setOpen({ id: asset.id })}
                      aria-label={`Edit ${itemName(asset, i)}`}
                      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold">
                          {itemName(asset, i)}
                          {roomName(asset.roomId) && (
                            <span className="text-ink-soft ml-2 text-[12.5px] font-medium">{roomName(asset.roomId)}</span>
                          )}
                        </span>
                        {itemSummary(asset) && (
                          <span className="text-ink-soft block truncate text-[12px]">{itemSummary(asset)}</span>
                        )}
                      </span>
                      <ExpiryChip asset={asset} />
                    </button>
                  </li>
                ),
              )}
            </ul>

            {open?.assetType === type ? (
              form({ assetType: type }, `Add ${assetTypeNoun(type)}`, patch => {
                addAsset(client.id, location.id, { assetType: type, ...patch })
                done()
              })
            ) : (
              <button
                type="button"
                onClick={() => setOpen({ assetType: type })}
                className="text-navy w-full border-t border-dashed border-slate-200 px-4 py-2.5 text-left text-[13.5px] font-semibold hover:bg-slate-50"
              >
                + Add {assetTypeNoun(type)}
              </button>
            )}

            {removed.length > 0 && (
              <div className="border-t border-slate-200 px-4 py-2">
                <button
                  type="button"
                  aria-expanded={!!showRemoved[type]}
                  onClick={() => setShowRemoved(s => ({ ...s, [type]: !s[type] }))}
                  className="text-ink-soft text-[12.5px] font-semibold hover:underline"
                >
                  Removed {assetTypePlural(type)} ({removed.length})
                </button>
                {showRemoved[type] && (
                  <ul className="m-0 mt-1 list-none p-0">
                    {removed.map(asset => (
                      <li key={asset.id} className="text-ink-soft py-1 text-[13px]">
                        {asset.label || assetTypeLabel(type)}
                        {roomName(asset.roomId) && ` · ${roomName(asset.roomId)}`} ·{' '}
                        {replacementOf(asset, assets) ? 'replaced' : 'removed'} {new Date(asset.removedAt).toLocaleDateString()}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )
      })}

      {askRemove && (
        <ConfirmDialog
          danger
          title={`Remove ${askRemove.name}?`}
          confirmLabel="Remove"
          onCancel={() => setAskRemove(null)}
          onConfirm={() => {
            removeAsset(client.id, location.id, askRemove.asset.id)
            setAskRemove(null)
            done()
          }}
        >
          It's no longer at this site, so it stops being tested and counted. It stays on record under
          Removed, and the reports that tested it still name it. To put a new one in its place, use
          Replace instead.
        </ConfirmDialog>
      )}
    </section>
  )
}

// 'Smoke alarms', 'RCDs'.
const heading = type => assetTypePlural(type).charAt(0).toUpperCase() + assetTypePlural(type).slice(1)

function ExpiryChip({ asset }) {
  if (!asset.expiresOn) return null
  const state = expiryState(asset)
  const cls =
    state === 'expired' ? 'bg-fail/10 text-fail' : state === 'soon' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-ink-soft'
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${cls}`}>
      {state === 'expired' ? 'Expired' : 'Expires'} {showDate(asset.expiresOn)}
    </span>
  )
}
