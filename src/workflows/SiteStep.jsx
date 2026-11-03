import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import AnswerInput from '../components/AnswerInput.jsx'
import FailNote from '../components/FailNote.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import ItemForm from '../components/ItemForm.jsx'
import Notice from '../components/Notice.jsx'
import { BackBar } from '../components/ClientBrowser.jsx'
import { addAsset, getSiteEntry, listAssets, replaceAsset, saveSiteEntry } from '../lib/clientStore.js'
import { getTemplate } from '../lib/templateStore.js'
import { isFail, noteKey, scopeOf, typeOf } from '../lib/testTypes.js'
import { gapLines, itemsFor, siteSectionsOf } from '../lib/siteStep.js'
import { replacementOf } from '../lib/equipment.js'
import { outsideChanges, subscribe } from '../lib/cache.js'
import { assetTypeLabel, assetTypeNoun, assetTypePlural } from '../data/packs/shared/assetTypes.js'

// The whole-site step (build plan C1): the sections a visit does once for the
// whole property, and those repeated for each item of one type at the site, such
// as each smoke alarm or each RCD. Kept on the visit as visits.site_results, in a
// room's shape (testTypes.js), each item's answers under its id:
//
//   results[sectionId][testId]            a whole-site section
//   results[sectionId][itemId][testId]    a section repeated per item
//
// One part of WorkflowPage.jsx, which opens it from the visit's room list.

function TestRow({ test, value, reading, onAnswer, readOnly }) {
  return (
    <div className="border-hair flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2.5 last:border-0">
      <span className="min-w-0 text-[14px] font-medium">{test.label}</span>
      <AnswerInput test={test} value={value} reading={reading} onAnswer={onAnswer} readOnly={readOnly} />
    </div>
  )
}

function AddItemForm({ assetType, rooms, onAdd, onCancel }) {
  const [label, setLabel] = useState('')
  const [roomId, setRoomId] = useState('')
  const what = assetTypeLabel(assetType)
  const noun = assetTypeNoun(assetType)
  return (
    <div className="border-hair flex flex-wrap items-end gap-2 border-t bg-slate-50 px-4 py-3">
      <label className="min-w-[180px] flex-1">
        <span className="text-ink-soft mb-1 block text-[12.5px] font-semibold">{what} name</span>
        <input
          autoFocus
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder={`e.g. ${what} by the front door`}
          aria-label={`New ${noun} name`}
          className="border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none"
        />
      </label>
      <label className="min-w-[160px]">
        <span className="text-ink-soft mb-1 block text-[12.5px] font-semibold">Room</span>
        <select
          value={roomId}
          onChange={e => setRoomId(e.target.value)}
          aria-label={`New ${noun} room`}
          className="border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none"
        >
          <option value="">Not in a room</option>
          {rooms.map(r => (
            <option key={r.id} value={r.id}>
              {[r.name || 'Unnamed room', r.floorLabel].filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onAdd({ label, roomId: roomId || null })}
        className="bg-navy min-h-[40px] rounded-lg px-4 text-[13px] font-semibold text-white hover:bg-[#24486e]"
      >
        Add {noun}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="border-hair text-ink-soft min-h-[40px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50"
      >
        Cancel
      </button>
    </div>
  )
}

// What a failed test that condemns its item says above the note: that it has to
// be replaced, with the replace flow, or what it was replaced with.
function ReplaceNote({ item, assets, rooms, name, canReplace, open, onOpen, onCancel, onReplace }) {
  const newer = item && replacementOf(item, assets)
  const said = newer
    ? `Replaced with ${newer.label || `a new ${assetTypeNoun(item.assetType)}`}. Note why the old one failed.`
    : item?.removedAt
      ? 'Removed. Note why it failed.'
      : 'Has to be replaced. Note why it failed.'
  return (
    <div className="border-fail/30 bg-fail/5 mb-2 overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p className="text-fail text-[13px] font-semibold">{said}</p>
        {item && !item.removedAt && canReplace && !open && (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Replace ${name}`}
            className="border-fail/40 text-fail min-h-[36px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-red-50"
          >
            Replace
          </button>
        )}
      </div>
      {open && item && (
        <ItemForm
          asset={{ assetType: item.assetType, label: item.label, roomId: item.roomId }}
          rooms={rooms}
          name={`Replacing ${name}`}
          saveLabel="Replace"
          onCancel={onCancel}
          onSave={onReplace}
        />
      )}
    </div>
  )
}

export default function SiteStep({ client, location, visit, rooms, readOnly, config, canManage, onBack, onChanged, onReopen }) {
  const { setDetail } = useOutletContext()
  useEffect(() => {
    setDetail('Whole site')
    return () => setDetail(null)
  }, [setDetail])

  const template = useMemo(() => getTemplate(config.templateKind), [config.templateKind])
  const stored = visit ? getSiteEntry(client.id, location.id, visit.id) : null
  // Snapshot the list the first time the step is opened, as a room does.
  const snapshot = stored?.template && Object.keys(stored.template).length ? stored.template : template
  const assets = listAssets(client.id, location.id)

  const [results, setResults] = useState(() => stored?.results ?? {})
  const [readings, setReadings] = useState(() => stored?.readings ?? {})
  const [sections, setSections] = useState(() => stored?.sections ?? {})
  const [troubleshooting, setTroubleshooting] = useState(() => stored?.troubleshooting ?? {})
  const [comments, setComments] = useState(() => stored?.comments ?? '')
  const [adding, setAdding] = useState(null)
  // The failed alarm being replaced from its note.
  const [replacing, setReplacing] = useState(null)
  const [pending, setPending] = useState(null)

  // Another device's answers merged in: catch up, as a room does.
  const seenChanges = useRef(outsideChanges())
  const savedComments = useRef(stored?.comments ?? '')
  useEffect(
    () =>
      subscribe(() => {
        if (outsideChanges() === seenChanges.current || !visit) return
        seenChanges.current = outsideChanges()
        const fresh = getSiteEntry(client.id, location.id, visit.id)
        if (!fresh) return
        setResults(fresh.results ?? {})
        setReadings(fresh.readings ?? {})
        setSections(fresh.sections ?? {})
        setTroubleshooting(fresh.troubleshooting ?? {})
        setComments(typed => (typed === savedComments.current ? (fresh.comments ?? '') : typed))
        savedComments.current = fresh.comments ?? ''
      }),
    [client.id, location.id, visit],
  )

  const persist = useCallback(
    patch => {
      if (readOnly || !visit) return
      saveSiteEntry(client.id, location.id, visit.id, {
        template: snapshot,
        results,
        readings,
        sections,
        troubleshooting,
        comments,
        ...patch,
      })
      onChanged()
    },
    [client.id, location.id, visit, snapshot, results, readings, sections, troubleshooting, comments, onChanged, readOnly],
  )

  const siteSections = siteSectionsOf(snapshot)
  const on = section => sections[section.id] !== false

  // Where an answer lives: results[section][test], or results[section][item][test].
  const read = (map, section, test, itemId) => (itemId ? map[section.id]?.[itemId] : map[section.id])?.[test.id]
  const write = (map, section, test, itemId, value) => {
    const group = { ...(map[section.id] ?? {}) }
    const place = itemId ? { ...(group[itemId] ?? {}) } : group
    if (value === undefined) delete place[test.id]
    else place[test.id] = value
    if (itemId) group[itemId] = place
    return { ...map, [section.id]: group }
  }

  const applyAnswer = ({ section, test, itemId, value, reading }) => {
    const was = read(results, section, test, itemId)
    const nextResults = write(results, section, test, itemId, value)
    const nextReadings =
      typeOf(test) === 'measure' ? write(readings, section, test, itemId, reading ?? undefined) : readings
    let nextNotes = troubleshooting
    const key = noteKey(test.id, itemId)
    if (isFail(test, was) && !isFail(test, value) && key in troubleshooting) {
      nextNotes = { ...troubleshooting }
      delete nextNotes[key]
    }
    setResults(nextResults)
    setReadings(nextReadings)
    setTroubleshooting(nextNotes)
    persist({ results: nextResults, readings: nextReadings, troubleshooting: nextNotes })
  }

  const answer = (section, test, itemId) => (value, reading) => {
    if (readOnly) return
    const was = read(results, section, test, itemId)
    const note = troubleshooting[noteKey(test.id, itemId)]
    // Leaving a fail discards its note: ask first, as a room does.
    if (isFail(test, was) && !isFail(test, value) && note && note.trim()) {
      setPending({ section, test, itemId, value, reading })
      return
    }
    applyAnswer({ section, test, itemId, value, reading })
  }

  const setNote = (key, text) => {
    if (readOnly) return
    const next = { ...troubleshooting, [key]: text }
    setTroubleshooting(next)
    persist({ troubleshooting: next })
  }

  const toggle = (section, value) => {
    if (readOnly) return
    const next = { ...sections, [section.id]: value }
    setSections(next)
    persist({ sections: next })
  }

  // An item's name in the step. One replaced keeps its name for the new one, so
  // the old one says what happened to it.
  const itemTitle = (item, i, section) =>
    (item.label || `${assetTypeLabel(section.assetType)} ${i + 1}`) +
    (!item.removedAt ? '' : replacementOf(item, assets) ? ' (replaced)' : ' (removed)')

  // The fails that show, in the order the step asks them.
  const failed = []
  for (const section of siteSections.filter(on)) {
    const places =
      scopeOf(section) === 'item'
        ? itemsFor(section, assets, results[section.id]).map((item, i) => ({ itemId: item.id, name: itemTitle(item, i, section) }))
        : [{ itemId: null, name: null }]
    for (const { itemId, name } of places) {
      for (const test of section.tests ?? []) {
        if (isFail(test, read(results, section, test, itemId))) failed.push({ test, itemId, name })
      }
    }
  }

  const gaps = gapLines(snapshot, rooms, assets)
  const prompt = config.notePrompt ?? 'Describe the issue / action taken'

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <BackBar title="Whole site" subtitle={`${client.name} · ${[location.address, location.suburb].filter(Boolean).join(', ')}`} onBack={onBack} />

        {readOnly && (
          <div className="border-navy/20 bg-navy/5 text-navy mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-[13.5px]">
            <span>
              {visit
                ? 'This visit is finished — showing what it recorded. Start a new visit to make changes.'
                : 'No visit has been started for this location yet. Start one to record results.'}
            </span>
            {visit && canManage && (
              <button
                type="button"
                onClick={onReopen}
                className="border-navy/30 text-navy min-h-[38px] shrink-0 rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50"
              >
                Reopen for editing
              </button>
            )}
          </div>
        )}

        {gaps.length > 0 && (
          <div className="mb-4">
            <Notice title="Coverage">
              <ul className="m-0 list-disc pl-5">
                {gaps.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Notice>
          </div>
        )}

        {siteSections.map(section => {
          const items = scopeOf(section) === 'item' ? itemsFor(section, assets, results[section.id]) : null
          const what = scopeOf(section) === 'item' ? assetTypeLabel(section.assetType) : null
          const noun = assetTypeNoun(section.assetType)
          return (
            <section key={section.id} className="border-hair mb-4 overflow-hidden rounded-xl border bg-white">
              <label className="border-hair flex cursor-pointer items-center gap-3 border-b bg-slate-50 px-4 py-3">
                <input
                  type="checkbox"
                  checked={on(section)}
                  onChange={e => toggle(section, e.target.checked)}
                  disabled={readOnly}
                  className="text-navy h-5 w-5 rounded disabled:opacity-60"
                />
                <span className="text-[13.5px] font-semibold">{section.label}</span>
              </label>

              {on(section) && !items &&
                section.tests.map(t => (
                  <TestRow
                    key={t.id}
                    test={t}
                    value={read(results, section, t)}
                    reading={read(readings, section, t)}
                    onAnswer={answer(section, t)}
                    readOnly={readOnly}
                  />
                ))}

              {on(section) && items && (
                <>
                  {items.length === 0 && (
                    <p className="text-ink-soft px-4 py-3 text-[13.5px]">
                      No {assetTypePlural(section.assetType)} recorded at this site yet. Add each one as you test it.
                    </p>
                  )}
                  {items.map((item, i) => {
                    const name = item.label || `${what} ${i + 1}`
                    const title = itemTitle(item, i, section)
                    const where = rooms.find(r => r.id === item.roomId)?.name
                    return (
                      <div key={item.id} className="border-hair border-b last:border-0">
                        <h4 className="text-ink bg-white px-4 pt-3 pb-1 text-[13.5px] font-bold">
                          {name}
                          {where && <span className="text-ink-soft ml-2 text-[12.5px] font-medium">{where}</span>}
                          {item.removedAt && <span className="text-ink-soft ml-2 text-[12.5px] font-medium">Removed</span>}
                        </h4>
                        <div className="pl-3" role="group" aria-label={title}>
                          {section.tests.map(t => (
                            <TestRow
                              key={t.id}
                              test={t}
                              value={read(results, section, t, item.id)}
                              reading={read(readings, section, t, item.id)}
                              onAnswer={answer(section, t, item.id)}
                              readOnly={readOnly}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {!readOnly &&
                    (adding === section.id ? (
                      <AddItemForm
                        assetType={section.assetType}
                        rooms={rooms}
                        onCancel={() => setAdding(null)}
                        onAdd={details => {
                          addAsset(client.id, location.id, { assetType: section.assetType, ...details })
                          setAdding(null)
                          onChanged()
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAdding(section.id)}
                        className="text-navy w-full border-t border-dashed border-slate-200 px-4 py-3 text-left text-[13.5px] font-semibold hover:bg-slate-50"
                      >
                        + Add {noun}
                      </button>
                    ))}
                </>
              )}
            </section>
          )
        })}

        <section className="border-hair mb-4 rounded-xl border bg-white p-4">
          <h3 className="mb-3 text-[14px] font-bold">Troubleshooting</h3>
          {failed.length === 0 ? (
            <p className="text-ink-soft text-[13.5px]">No issues identified.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {failed.map(({ test, itemId, name }) => {
                const key = noteKey(test.id, itemId)
                const label = name ? `${name} — ${test.label}` : test.label
                return (
                  <FailNote
                    key={key}
                    label={label}
                    note={troubleshooting[key]}
                    onChange={text => setNote(key, text)}
                    suggestions={snapshot.failNotes}
                    readOnly={readOnly}
                    placeholder={prompt}
                  >
                    {test.onFail === 'replace' && (
                      <ReplaceNote
                        item={assets.find(a => a.id === itemId)}
                        assets={assets}
                        rooms={rooms}
                        name={name}
                        canReplace={!readOnly && !!visit}
                        open={replacing === itemId}
                        onOpen={() => setReplacing(itemId)}
                        onCancel={() => setReplacing(null)}
                        onReplace={details => {
                          replaceAsset(client.id, location.id, itemId, details)
                          setReplacing(null)
                          onChanged()
                        }}
                      />
                    )}
                  </FailNote>
                )
              })}
            </div>
          )}
        </section>

        <section className="border-hair mb-4 rounded-xl border bg-white p-4">
          <h3 className="mb-3 text-[14px] font-bold">Comments</h3>
          <textarea
            rows={3}
            value={comments}
            onChange={e => setComments(e.target.value)}
            onBlur={() => {
              if (readOnly) return
              savedComments.current = comments
              persist({ comments })
            }}
            readOnly={readOnly}
            aria-label="Whole-site comments"
            placeholder="Any general notes for the whole site"
            className="border-hair text-ink focus:border-navy w-full resize-y rounded-lg border px-3 py-2 text-[14px] outline-none"
          />
        </section>
      </div>

      {pending && (
        <ConfirmDialog
          danger
          title={`Discard troubleshooting notes for "${pending.test.label}"?`}
          confirmLabel="Discard notes"
          cancelLabel="Keep the note"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            applyAnswer(pending)
            setPending(null)
          }}
        >
          Changing the answer so it no longer fails removes the notes you typed for it.
        </ConfirmDialog>
      )}

      <footer className="border-hair mt-2 shrink-0 border-t-2 bg-white py-3">
        <button
          type="button"
          onClick={onBack}
          className="border-hair text-ink min-h-[48px] w-full rounded-lg border bg-white text-[13.5px] font-semibold hover:bg-slate-50"
        >
          Back to the rooms
        </button>
      </footer>
    </div>
  )
}
