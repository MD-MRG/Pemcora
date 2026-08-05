import { useState } from 'react'
import { getTemplate, saveTemplate, resetTemplate } from '../lib/templateStore.js'
import ConfirmDialog from './ConfirmDialog.jsx'

// Editor for one test template.
//
// Reordering is by up/down buttons rather than drag: they work identically with
// a finger, a mouse and a keyboard, need no library, and — unlike drag — can
// actually be verified. Drag can be added later if it earns its place.

const uid = () => crypto.randomUUID()
const reindex = list => list.map((item, i) => ({ ...item, order: i }))
const move = (list, from, to) => {
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return reindex(next)
}

const iconBtn =
  'shrink-0 rounded-md px-2 py-2 text-[15px] leading-none text-ink-soft hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent'

function TestRows({ tests, groupLabel, onChange }) {
  return (
    <div className="flex flex-col">
      {tests.map((test, i) => (
        <div key={test.id} className="border-hair flex items-center gap-1 border-b py-2 last:border-0">
          <input
            value={test.label}
            onChange={e => onChange(tests.map(t => (t.id === test.id ? { ...t, label: e.target.value } : t)))}
            placeholder="Test name"
            aria-label={`${groupLabel} test ${i + 1}`}
            className="border-hair text-ink focus:border-navy min-w-0 flex-1 rounded-lg border px-3 py-2 text-[14px] outline-none"
          />
          <button
            type="button"
            className={iconBtn}
            disabled={i === 0}
            aria-label={`Move ${test.label || `test ${i + 1}`} up`}
            onClick={() => onChange(move(tests, i, i - 1))}
          >
            ↑
          </button>
          <button
            type="button"
            className={iconBtn}
            disabled={i === tests.length - 1}
            aria-label={`Move ${test.label || `test ${i + 1}`} down`}
            onClick={() => onChange(move(tests, i, i + 1))}
          >
            ↓
          </button>
          <button
            type="button"
            className="text-fail shrink-0 rounded-md px-2 py-2 text-[15px] leading-none hover:bg-red-50"
            aria-label={`Remove ${test.label || `test ${i + 1}`}`}
            onClick={() => onChange(reindex(tests.filter(t => t.id !== test.id)))}
          >
            ✕
          </button>
        </div>
      ))}

      {tests.length === 0 && (
        <p className="text-ink-soft py-2 text-[13px]">No tests yet.</p>
      )}

      <button
        type="button"
        onClick={() => onChange(reindex([...tests, { id: uid(), label: '', order: tests.length }]))}
        className="text-navy mt-2 self-start text-[13px] font-semibold hover:underline"
      >
        + Add test
      </button>
    </div>
  )
}

export default function TemplateEditor({ kind, title, note }) {
  const [template, setTemplate] = useState(() => getTemplate(kind))
  const [confirm, setConfirm] = useState(null)

  const apply = next => {
    setTemplate(next)
    saveTemplate(kind, next)
  }

  const setSection = (id, patch) =>
    apply({ ...template, sections: template.sections.map(s => (s.id === id ? { ...s, ...patch } : s)) })

  const addSection = () =>
    apply({
      ...template,
      sections: reindex([
        ...template.sections,
        { id: uid(), label: '', order: template.sections.length, tests: [] },
      ]),
    })

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-bold">{title}</h3>
          <p className="text-ink-soft mt-0.5 max-w-[62ch] text-[13px]">{note}</p>
        </div>
        <button
          type="button"
          onClick={() => setConfirm({ type: 'reset' })}
          className="border-hair text-ink-soft min-h-[38px] shrink-0 rounded-lg border px-3 text-[12.5px] font-semibold hover:bg-slate-50"
        >
          Reset to defaults
        </button>
      </div>

      {/* Main list — its heading is renameable, which is what Custom List needs */}
      <div className="border-hair mt-4 rounded-xl border p-4">
        <label className="block">
          <span className="text-ink-soft mb-1.5 block text-[12px] font-semibold tracking-[.06em] uppercase">
            Main list heading
          </span>
          <input
            value={template.mainLabel}
            onChange={e => apply({ ...template, mainLabel: e.target.value })}
            aria-label="Main list heading"
            placeholder="e.g. Main test list"
            className="border-hair text-ink focus:border-navy w-full max-w-sm rounded-lg border px-3 py-2 text-[14px] font-semibold outline-none"
          />
        </label>
        <div className="mt-3">
          <TestRows
            tests={template.tests}
            groupLabel="Main"
            onChange={tests => apply({ ...template, tests })}
          />
        </div>
      </div>

      {template.sections.map((section, si) => (
        <div key={section.id} className="border-hair mt-3 rounded-xl border p-4">
          <div className="flex items-center gap-1">
            <input
              value={section.label}
              onChange={e => setSection(section.id, { label: e.target.value })}
              aria-label={`Section ${si + 1} name`}
              placeholder="Section name"
              className="border-hair text-ink focus:border-navy min-w-0 flex-1 rounded-lg border px-3 py-2 text-[14px] font-semibold outline-none"
            />
            <button
              type="button"
              className={iconBtn}
              disabled={si === 0}
              aria-label={`Move section ${section.label || si + 1} up`}
              onClick={() => apply({ ...template, sections: move(template.sections, si, si - 1) })}
            >
              ↑
            </button>
            <button
              type="button"
              className={iconBtn}
              disabled={si === template.sections.length - 1}
              aria-label={`Move section ${section.label || si + 1} down`}
              onClick={() => apply({ ...template, sections: move(template.sections, si, si + 1) })}
            >
              ↓
            </button>
            <button
              type="button"
              className="text-fail shrink-0 rounded-md px-2.5 py-2 text-[12.5px] font-semibold hover:bg-red-50"
              onClick={() => setConfirm({ type: 'section', section })}
            >
              Remove
            </button>
          </div>
          <div className="mt-3">
            <TestRows
              tests={section.tests}
              groupLabel={section.label || `Section ${si + 1}`}
              onChange={tests => setSection(section.id, { tests })}
            />
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addSection}
        className="border-hair text-navy mt-3 min-h-[44px] w-full rounded-lg border border-dashed text-[13.5px] font-semibold hover:bg-slate-50"
      >
        + Add section
      </button>

      {confirm?.type === 'reset' && (
        <ConfirmDialog
          danger
          title={`Reset ${title} to defaults?`}
          confirmLabel="Reset"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setTemplate(resetTemplate(kind))
            setConfirm(null)
          }}
        >
          Every edit to this list is discarded. Rooms already filled in keep the tests they were
          completed with.
        </ConfirmDialog>
      )}

      {confirm?.type === 'section' && (
        <ConfirmDialog
          danger
          title={`Remove "${confirm.section.label || 'this section'}"?`}
          confirmLabel="Remove section"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            apply({
              ...template,
              sections: reindex(template.sections.filter(s => s.id !== confirm.section.id)),
            })
            setConfirm(null)
          }}
        >
          Its {confirm.section.tests.length} test{confirm.section.tests.length === 1 ? '' : 's'} go
          with it. Rooms already filled in are unaffected.
        </ConfirmDialog>
      )}
    </div>
  )
}
