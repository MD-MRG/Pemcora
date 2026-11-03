import { useState } from 'react'
import PackPicker from './PackPicker.jsx'
import { PACKS, packById } from '../data/packs/index.js'
import { OPEN_NOW, STATES, TRADES, starterPackFor, stateIsOpen, tradeIsOpen } from '../lib/signup.js'

const ACTION =
  'bg-navy min-h-[46px] rounded-lg px-5 text-[13.5px] font-semibold text-white hover:bg-[#24486e] disabled:cursor-not-allowed disabled:opacity-55'
const QUIET =
  'border-hair text-ink min-h-[46px] rounded-lg border bg-white px-4 text-[13.5px] font-semibold hover:bg-slate-50'

/**
 * What a new team does, then one screen confirming what that gives it (build plan 2.3,
 * and M.D.'s note there). Used for a person's first team and for any team they make
 * later, because a team's type is fixed when it's created and a new inspecting team
 * must never get AV without asking.
 *
 * Hands onConfirm { accountType, packId, state, addons }. `opening` says what can be
 * chosen yet, and only the tests pass their own.
 */
export default function TeamChoices({
  opening = OPEN_NOW,
  busy = false,
  canConfirm = true,
  confirmLabel = 'Create team',
  onConfirm,
}) {
  const [confirming, setConfirming] = useState(false)
  const [tradeId, setTradeId] = useState(null)
  const [stateId, setStateId] = useState('')
  const [changedPack, setChangedPack] = useState(null)
  const [changing, setChanging] = useState(false)
  const [addons, setAddons] = useState([])

  const trade = TRADES.find(t => t.id === tradeId) ?? null
  const answered = !!trade && (!trade.asksState || (stateId && stateIsOpen(stateId, opening)))
  const matched = trade ? starterPackFor(trade.id, stateId) : null
  const packId = changedPack ?? matched
  const offered = PACKS.filter(p => p.id !== 'core' && opening.pack(p))
  const otherPacks = offered.filter(p => p.id !== packId)

  if (!confirming) {
    return (
      <div className="flex flex-col gap-4">
        <fieldset className="m-0 border-0 p-0">
          <legend className="text-ink mb-2 block text-[14px] font-semibold">
            What does your team do?
          </legend>
          <div className="flex flex-col gap-2">
            {TRADES.map(t => {
              const open = tradeIsOpen(t, opening)
              return (
                <label
                  key={t.id}
                  className={`border-hair flex min-h-[46px] items-center gap-3 rounded-lg border bg-white px-3 py-2 text-[14px] ${
                    open ? 'cursor-pointer hover:bg-slate-50' : 'text-ink-soft cursor-not-allowed bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="trade"
                    disabled={!open}
                    checked={tradeId === t.id}
                    onChange={() => {
                      setTradeId(t.id)
                      setStateId('')
                      setChangedPack(null)
                      setChanging(false)
                      setAddons([])
                    }}
                    className="text-navy h-4 w-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">{t.label}</span>
                  {!open && <span className="shrink-0 text-[12px] font-semibold">Coming soon</span>}
                </label>
              )
            })}
          </div>
        </fieldset>

        {trade?.asksState && (
          <label className="block">
            <span className="text-ink mb-2 block text-[14px] font-semibold">Which state is it in?</span>
            <select
              value={stateId}
              onChange={e => {
                setStateId(e.target.value)
                setChangedPack(null)
                setAddons([])
              }}
              className="border-hair text-ink focus:border-navy min-h-[46px] w-full rounded-lg border bg-white px-3 text-[14px] outline-none"
            >
              <option value="">Choose a state</option>
              {STATES.map(state => {
                const open = stateIsOpen(state.id, opening)
                return (
                  <option key={state.id} value={state.id} disabled={!open}>
                    {state.label}
                    {open ? '' : ' (coming soon)'}
                  </option>
                )
              })}
            </select>
          </label>
        )}

        <div>
          <button type="button" disabled={!answered} onClick={() => setConfirming(true)} className={ACTION}>
            Continue
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {packId ? (
        <>
          <div>
            <p className="text-ink-soft text-[12.5px] font-semibold">Your starter pack</p>
            <p className="text-ink mt-0.5 text-[15px] font-semibold">{packById(packId).label}</p>
            {!changing && otherPacks.length > 0 && (
              <button
                type="button"
                onClick={() => setChanging(true)}
                className="text-navy mt-1 text-[13px] font-semibold underline-offset-2 hover:underline"
              >
                Change
              </button>
            )}
          </div>

          {changing && (
            <PackPicker
              label="Choose your starter pack"
              packs={offered}
              value={packId}
              onChange={id => {
                setChangedPack(id)
                setAddons(wanted => wanted.filter(a => a !== id))
              }}
            />
          )}

          {otherPacks.length > 0 && (
            <fieldset className="m-0 border-0 p-0">
              <legend className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">
                Add another pack?
              </legend>
              <div className="flex flex-col gap-2">
                <label className="border-hair flex min-h-[46px] cursor-pointer items-center gap-3 rounded-lg border bg-white px-3 py-2 text-[14px] hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={addons.length === 0}
                    onChange={() => setAddons([])}
                    className="text-navy h-4 w-4 shrink-0"
                  />
                  No add-on
                </label>
                {otherPacks.map(pack => (
                  <label
                    key={pack.id}
                    className="border-hair flex min-h-[46px] cursor-pointer items-center gap-3 rounded-lg border bg-white px-3 py-2 text-[14px] hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={addons.includes(pack.id)}
                      onChange={e =>
                        setAddons(wanted =>
                          e.target.checked ? [...wanted, pack.id] : wanted.filter(a => a !== pack.id),
                        )
                      }
                      className="text-navy h-4 w-4 shrink-0"
                    />
                    {pack.label}
                  </label>
                ))}
              </div>
              {/* Step E1 adds their prices and connects them to checkout. */}
              {addons.length > 0 && (
                <p className="text-ink-soft mt-2 text-[13px]">
                  Add-ons aren't on sale yet. We'll note your choice, and your team starts with its
                  starter pack.
                </p>
              )}
            </fieldset>
          )}

          <p className="text-ink-soft text-[13px]">You can add packs any time.</p>
        </>
      ) : (
        <p className="text-ink-soft text-[13.5px]">
          You'll receive reports from the people who inspect your properties, so your team doesn't
          need a pack.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setConfirming(false)} className={QUIET}>
          Back
        </button>
        <button
          type="button"
          disabled={busy || !canConfirm}
          onClick={() =>
            onConfirm({
              accountType: trade.accountType,
              packId,
              state: trade.asksState ? stateId : null,
              addons,
            })
          }
          className={ACTION}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  )
}
