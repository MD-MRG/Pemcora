import { useOutletContext } from 'react-router-dom'
import { useState } from 'react'
import { PLATE_LIST, PLATES } from '../lib/plates.js'
import { BrandMark } from '../components/icons.jsx'
import Field from '../components/Field.jsx'
import LogoUpload from '../components/LogoUpload.jsx'
import TemplateEditor from '../components/TemplateEditor.jsx'
import ImportLocalData from '../components/ImportLocalData.jsx'
import AccountPanel from '../components/AccountPanel.jsx'
import StarterPackCard from '../components/StarterPackCard.jsx'
import { getSettings, saveSettings, saveCompany, storageUsage } from '../lib/settingsStore.js'
import { useEntitlements } from '../context/team.js'
import { isProvider, usesPack } from '../lib/entitlements.js'
import { WORKFLOWS, workflow } from '../data/packs/index.js'

const TEMPLATES = [
  {
    kind: 'maintenance',
    tab: 'Preventative Maintenance',
    title: 'Preventative Maintenance tests',
    note: 'Run on every recurring service visit.',
  },
  {
    kind: 'commissioning',
    tab: 'Commissioning',
    title: 'Commissioning tests',
    note: 'Run at handover. Its own copy — editing it never touches the maintenance list.',
  },
  {
    kind: 'custom',
    tab: 'Custom List',
    title: 'Custom List tests',
    note: 'Starts empty. Build the list and name the sections however the job needs.',
  },
  // Every other workflow's list, named as its page is.
  ...WORKFLOWS.filter(w => !['maintenance', 'commissioning', 'custom'].includes(w.id)).map(w => ({
    kind: w.id,
    tab: w.nav.label,
    title: `${w.page.title} tests`,
    note: 'A proposed list, built from the official forms and rules. A licensed electrician checks it before it ships.',
  })),
]

function PlateSwatch({ plate, selected, onSelect, logo }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(plate.key)}
      aria-pressed={selected}
      aria-label={`Background ${plate.name}`}
      className={`border-hair rounded-xl border-2 bg-white text-left transition-transform hover:-translate-y-px ${
        selected ? 'border-navy shadow-[0_0_0_3px_rgba(27,58,92,.15)]' : ''
      }`}
    >
      <div
        className="flex h-[62px] items-center gap-2.5 rounded-t-[10px] px-3.5"
        style={{ background: plate.bg, color: plate.fg }}
      >
        {logo ? (
          <img src={logo.src} alt="" className="max-h-9 max-w-[140px] object-contain" />
        ) : (
          <>
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
              style={{ background: plate.mark, border: `1px solid ${plate.edge}` }}
            >
              <BrandMark size={17} />
            </span>
            <span className="min-w-0 text-[13px] leading-tight font-bold">Your logo</span>
          </>
        )}
      </div>
      <div className="px-3.5 py-2.5">
        <div className="flex items-baseline gap-2">
          <b className="text-[13.5px]">{plate.name}</b>
          <code className="text-ink-soft font-mono text-[11.5px]">{plate.hex}</code>
        </div>
      </div>
    </button>
  )
}

export default function Settings() {
  const { plate, setPlate, refreshSettings } = useOutletContext()
  const [settings, setSettings] = useState(() => getSettings())
  const [saveError, setSaveError] = useState('')
  const [templateKind, setTemplateKind] = useState('maintenance')

  // Only the lists of the packs this team holds. A landlord or agency inspects
  // nothing, so it has no lists and no technician to record.
  const entitlements = useEntitlements()
  const inspects = isProvider(entitlements)
  const lists = TEMPLATES.filter(t => usesPack(entitlements, workflow(t.kind).packId))
  const shownKind = lists.some(t => t.kind === templateKind) ? templateKind : lists[0]?.kind
  // A team whose checks end in a sign-off: licence numbers belong on its reports.
  const signsOff = WORKFLOWS.some(w => w.page?.signoff && usesPack(entitlements, w.packId))

  const update = patch => {
    const { ok, settings: next } = saveSettings(patch)
    setSettings(next)
    refreshSettings() // repaint the brand plate immediately
    setSaveError(
      ok ? '' : 'Storage is full — remove a logo or clear old data before saving again.',
    )
  }
  const updateCompany = patch => {
    const { ok, settings: next } = saveCompany(patch)
    setSettings(next)
    refreshSettings()
    setSaveError(ok ? '' : 'Storage is full — remove a logo before saving again.')
  }

  const activePlate = PLATES[plate] ?? PLATES.brass
  const usage = storageUsage()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      {saveError && (
        <p className="border-fail/30 bg-fail/5 text-fail rounded-lg border px-4 py-3 text-[13.5px]">
          {saveError}
        </p>
      )}

      {/* First, not last. It is the shortest section on a long page, and someone
          hunting for "sign out" should not have to scroll past branding and
          sixty test items to find it. Renders nothing without a session. */}
      <AccountPanel />

      <StarterPackCard />

      <section className="border-hair rounded-xl border bg-white p-6">
        <h2 className="text-[19px] font-bold tracking-[-.01em]">Company</h2>
        <p className="text-ink-soft mt-1 text-[14px]">
          Printed on every report you send a client, and shown beside your logo.
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field
            label="Company name"
            value={settings.company.name}
            onChange={v => updateCompany({ name: v })}
            placeholder="e.g. Northpoint Audio Visual"
            className="sm:col-span-2"
          />
          <Field label="ABN" value={settings.company.abn} onChange={v => updateCompany({ abn: v })} placeholder="e.g. 12 345 678 901" />
          <Field label="Phone" value={settings.company.phone} onChange={v => updateCompany({ phone: v })} placeholder="e.g. 02 9000 0000" />
          <Field
            label="Email"
            value={settings.company.email}
            onChange={v => updateCompany({ email: v })}
            placeholder="e.g. service@northpoint.com.au"
            className="sm:col-span-2"
          />
          {signsOff && (
            <>
              <Field
                label="Licence number"
                value={settings.company.licence_number}
                onChange={v => updateCompany({ licence_number: v })}
                placeholder="The business's electrical licence"
              />
              <Field
                label="REC number"
                value={settings.company.rec_number}
                onChange={v => updateCompany({ rec_number: v })}
                placeholder="Registered electrical contractor"
              />
            </>
          )}
        </div>
      </section>

      <section className="border-hair rounded-xl border bg-white p-6">
        <h2 className="text-[19px] font-bold tracking-[-.01em]">Branding</h2>
        <p className="text-ink-soft mt-1 max-w-[62ch] text-[14px]">
          Two logos, because they do different jobs: the full mark sits in the open sidebar, and a
          square one has to read at 40&nbsp;px in the collapsed rail.
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <LogoUpload
            label="Full logo"
            hint="Open sidebar · about 180×44"
            logo={settings.logoFull}
            plate={activePlate}
            onChange={logo => update({ logoFull: logo })}
          />
          <LogoUpload
            label="Collapsed logo"
            hint="Rail · 40×40 square"
            logo={settings.logoCollapsed}
            plate={activePlate}
            square
            onChange={logo => update({ logoCollapsed: logo })}
          />
        </div>

        <h3 className="mt-7 text-[14px] font-bold">Background</h3>
        <p className="text-ink-soft mt-0.5 text-[13px]">
          Check your logo against each — a dark mark disappears on Espresso, a pale one on Bone.
        </p>
        <div className="mt-4 grid gap-3.5 sm:grid-cols-2">
          {PLATE_LIST.map(p => (
            <PlateSwatch
              key={p.key}
              plate={p}
              selected={plate === p.key}
              onSelect={key => {
                setPlate(key)
                update({ plate: key })
              }}
              logo={settings.logoFull}
            />
          ))}
        </div>
      </section>

      {inspects && (
        <section className="border-hair rounded-xl border bg-white p-6">
          <h2 className="text-[19px] font-bold tracking-[-.01em]">Technician</h2>
          <p className="text-ink-soft mt-1 max-w-[62ch] text-[14px]">
            Recorded against each new visit and printed on its report. It can be changed on the visit
            itself when a colleague attends.
          </p>
          <div className="mt-4 max-w-sm">
            <Field
              label="Default technician"
              value={settings.technician}
              onChange={v => update({ technician: v })}
              placeholder="e.g. Michal Dolezal"
            />
          </div>
          {signsOff && (
            <div className="mt-4 max-w-sm">
              <Field
                label="Your licence or registration number"
                value={settings.licenceNumber}
                onChange={v => update({ licenceNumber: v })}
                placeholder="e.g. A12345"
              />
              <p className="text-ink-soft mt-1.5 text-[12.5px]">
                Yours alone, not the team's. Filled in for you when you sign off a check.
              </p>
            </div>
          )}
        </section>
      )}

      {inspects && (
        <section className="border-hair rounded-xl border bg-white p-6">
          <h2 className="text-[19px] font-bold tracking-[-.01em]">Reminders</h2>
          <label className="mt-4 flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={settings.remindersEnabled !== false}
              onChange={e => update({ remindersEnabled: e.target.checked })}
              aria-describedby="team-reminders-note"
              className="text-navy h-5 w-5 rounded"
            />
            <span className="text-[14px] font-semibold">Send re-check reminders</span>
          </label>
          <p id="team-reminders-note" className="text-ink-soft mt-1 max-w-[62ch] pl-8 text-[13.5px]">
            Emails each client's contact as a check at their site comes due, on Pro. Switching this
            off stops them for every client; each client can also be switched off on its own.
            Reminder emails start in a later update.
          </p>
        </section>
      )}

      {inspects && (
        <section className="border-hair rounded-xl border bg-white p-6">
          <h2 className="text-[19px] font-bold tracking-[-.01em]">Test lists</h2>
          <p className="text-ink-soft mt-1 max-w-[62ch] text-[14px]">
            Each workflow keeps its own list. <b>Changes apply to new rooms only</b> — a room already
            filled in keeps the tests it was completed with, so editing here can never rewrite work
            that has been signed off.
          </p>

          <div className="border-hair mt-5 flex flex-wrap gap-1 border-b">
            {lists.map(t => (
              <button
                key={t.kind}
                type="button"
                onClick={() => setTemplateKind(t.kind)}
                aria-pressed={shownKind === t.kind}
                className={`-mb-px min-h-[42px] rounded-t-lg border-b-2 px-4 text-[13.5px] font-semibold ${
                  shownKind === t.kind
                    ? 'border-navy text-navy'
                    : 'text-ink-soft border-transparent hover:bg-slate-50'
                }`}
              >
                {t.tab}
              </button>
            ))}
          </div>

          <div className="mt-5">
            {lists.filter(t => t.kind === shownKind).map(t => (
              <TemplateEditor key={t.kind} kind={t.kind} title={t.title} note={t.note} />
            ))}
          </div>
        </section>
      )}

      <ImportLocalData />

      <p className="text-ink-soft px-1 text-[12.5px]">
        {usage ? (
          <>
            Saved on this device. Logos share the same storage as your client and visit data —
            currently using <b>{usage.label}</b>.
          </>
        ) : (
          // Signed in there is no shared 5MB budget to warn about, and these
          // settings are the team's rather than this browser's.
          <>Shared with your team, and available on every device you sign in from.</>
        )}
      </p>
    </div>
  )
}
