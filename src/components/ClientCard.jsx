import { useState } from 'react'
import Field from './Field.jsx'
import IntervalSettings from './IntervalSettings.jsx'
import { updateClientDetails } from '../lib/clientStore.js'
import { getSettings } from '../lib/settingsStore.js'
import { useEntitlements } from '../context/team.js'
import { recurringWorkflows } from '../lib/intervals.js'

// This client's own intervals, under its contact: only for a team with a
// recurring check.
function IntervalsHere({ client }) {
  const entitlements = useEntitlements()
  if (!recurringWorkflows(entitlements).length) return null
  return (
    <div className="border-hair mt-5 border-t pt-4">
      <h3 className="text-[14px] font-bold">How often checks are due here</h3>
      <p className="text-ink-soft mt-0.5 mb-3 text-[13px]">
        Left blank, {client.name}'s sites follow the team default in Settings.
      </p>
      <IntervalSettings clientId={client.id} />
    </div>
  )
}

// A client's own details on Edit Client, above its sites (build plan C3): who
// its reports and re-check reminders go to, and whether it gets reminders. They
// save as they're typed, offline too, like the rest of the client.
export default function ClientCard({ client, children }) {
  const [details, setDetails] = useState(() => ({
    contactName: client.contactName ?? '',
    contactEmail: client.contactEmail ?? '',
    contactPhone: client.contactPhone ?? '',
    remindersEnabled: client.remindersEnabled !== false,
  }))
  const set = (key, value) => {
    setDetails(d => ({ ...d, [key]: value }))
    updateClientDetails(client.id, { [key]: value })
  }
  const email = details.contactEmail.trim()
  const teamOff = getSettings().remindersEnabled === false

  return (
    <section className="border-hair mb-4 rounded-xl border bg-white p-5 shadow-sm" aria-label={`${client.name} details`}>
      <h2 className="text-[16px] font-bold">Contact</h2>
      <p className="text-ink-soft mt-0.5 text-[13.5px]">Who reports and re-check reminders go to.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Contact name" value={details.contactName} onChange={v => set('contactName', v)} placeholder="e.g. Jane Citizen" />
        <Field label="Contact phone" value={details.contactPhone} onChange={v => set('contactPhone', v)} placeholder="e.g. 0400 000 000" inputMode="tel" />
        <div className="sm:col-span-2">
          <Field
            label="Contact email"
            type="email"
            value={details.contactEmail}
            onChange={v => set('contactEmail', v)}
            placeholder="e.g. jane@example.com"
          />
          {email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && (
            <p className="mt-1 text-[12.5px] font-semibold text-amber-800">
              That doesn't look like an email address. Reports and reminders can't reach it.
            </p>
          )}
        </div>
      </div>

      <label className="mt-4 flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={details.remindersEnabled}
          onChange={e => set('remindersEnabled', e.target.checked)}
          aria-describedby={`reminders-${client.id}`}
          className="text-navy h-5 w-5 rounded"
        />
        <span className="text-[14px] font-semibold">Send this client re-check reminders</span>
      </label>
      <p id={`reminders-${client.id}`} className="text-ink-soft mt-1 pl-8 text-[13px]">
        {teamOff
          ? 'Reminders are switched off for the whole team in Settings, so none go out.'
          : 'Emailed to the contact as a check at one of their sites comes due.'}
      </p>

      <IntervalsHere client={client} />
      {children}
    </section>
  )
}
