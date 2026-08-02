import { useState, useMemo } from 'react'
import { distinctValues, normalise } from '../lib/clientStore.js'

// The client → location browser, shared by Edit Client and Preventative
// Maintenance. Both pages start the same way, so they use the same code rather
// than two implementations that drift apart.

const uniq = xs => [...new Set(xs.filter(Boolean))]

export function BackBar({ title, subtitle, onBack, right }) {
  return (
    <div className="border-hair mb-4 flex items-center justify-between gap-3 border-b pb-3">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="border-hair text-navy min-h-[38px] shrink-0 rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50"
        >
          ← Back
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-[17px] leading-tight font-bold">{title}</h2>
          {subtitle && <p className="text-ink-soft truncate text-[12.5px]">{subtitle}</p>}
        </div>
      </div>
      {right}
    </div>
  )
}

export function ClientsTable({ clients, onOpen }) {
  const [query, setQuery] = useState('')
  const [field, setField] = useState('all')
  const [value, setValue] = useState('')

  const options = useMemo(() => (field === 'all' ? [] : distinctValues(field)), [field, clients])

  const rows = useMemo(() => {
    const q = normalise(query)
    return clients
      .filter(c => (q ? normalise(c.name).includes(q) : true))
      // A client stays in the list if ANY of its locations matches, so a
      // Melbourne site doesn't hide Equinix when filtering by NSW.
      .filter(c =>
        field === 'all' || !value
          ? true
          : c.locations.some(l => normalise(l[field]) === normalise(value)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [clients, query, field, value])

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="min-w-[220px] flex-1">
          <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">
            Search by name
          </span>
          <span className="relative block">
            <span
              aria-hidden="true"
              className="text-ink-soft absolute top-1/2 left-3 -translate-y-1/2"
            >
              <svg
                viewBox="0 0 24 24"
                width="17"
                height="17"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4.5 4.5" />
              </svg>
            </span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Client name"
              className="border-hair text-ink focus:border-navy w-full rounded-lg border bg-white py-2.5 pr-3 pl-9 text-[14.5px] outline-none"
            />
          </span>
        </label>

        <label>
          <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold">Filter</span>
          <select
            value={field}
            onChange={e => {
              setField(e.target.value)
              setValue('')
            }}
            className="border-hair text-ink focus:border-navy min-h-[44px] rounded-lg border bg-white px-3 text-[14px] outline-none"
          >
            <option value="all">All</option>
            <option value="state">State</option>
            <option value="city">City</option>
          </select>
        </label>

        {field !== 'all' && (
          <label>
            <span className="text-ink-soft mb-1.5 block text-[12.5px] font-semibold capitalize">
              {field}
            </span>
            <select
              value={value}
              onChange={e => setValue(e.target.value)}
              aria-label={`Filter by ${field}`}
              className="border-hair text-ink focus:border-navy min-h-[44px] rounded-lg border bg-white px-3 text-[14px] outline-none"
            >
              <option value="">Any</option>
              {options.map(o => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {clients.length === 0 ? (
        <p className="text-ink-soft text-[14px]">
          No clients yet — add one from the New Client page.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-ink-soft text-[14px]">No clients match that search.</p>
      ) : (
        <div className="border-hair overflow-x-auto rounded-xl border bg-white">
          <table className="w-full border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-hair text-ink-soft border-b bg-slate-50 text-[11.5px] tracking-[.08em] uppercase">
                <th className="px-4 py-3 font-semibold">Client</th>
                <th className="px-4 py-3 font-semibold">State</th>
                <th className="px-4 py-3 font-semibold">City</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => {
                const states = uniq(c.locations.map(l => l.state))
                const cities = uniq(c.locations.map(l => l.city))
                return (
                  <tr
                    key={c.id}
                    onClick={() => onOpen(c.id)}
                    className="border-hair cursor-pointer border-b last:border-0 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3">
                      <button type="button" className="text-left font-semibold">
                        {c.name}
                      </button>
                      {c.locations.length > 1 && (
                        <span className="bg-navy/8 text-navy ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold">
                          {c.locations.length} locations
                        </span>
                      )}
                    </td>
                    <td className="text-ink-soft px-4 py-3">{states.join(', ') || '—'}</td>
                    <td className="text-ink-soft px-4 py-3">{cities.join(', ') || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

export function LocationsTable({ client, onBack, onOpen, subtitle }) {
  return (
    <>
      <BackBar
        title={client.name}
        subtitle={subtitle ?? `${client.locations.length} location(s)`}
        onBack={onBack}
      />
      <div className="border-hair overflow-x-auto rounded-xl border bg-white">
        <table className="w-full border-collapse text-left text-[14px]">
          <thead>
            <tr className="border-hair text-ink-soft border-b bg-slate-50 text-[11.5px] tracking-[.08em] uppercase">
              <th className="px-4 py-3 font-semibold">State</th>
              <th className="px-4 py-3 font-semibold">City</th>
              <th className="px-4 py-3 font-semibold">Street address</th>
              <th className="px-4 py-3 font-semibold">Suburb</th>
              <th className="px-4 py-3 font-semibold">Postcode</th>
            </tr>
          </thead>
          <tbody>
            {client.locations.map(l => (
              <tr
                key={l.id}
                onClick={() => onOpen(l.id)}
                className="border-hair cursor-pointer border-b last:border-0 hover:bg-slate-50"
              >
                <td className="px-4 py-3">{l.state || '—'}</td>
                <td className="px-4 py-3">{l.city || '—'}</td>
                <td className="px-4 py-3 font-semibold">{l.address || '—'}</td>
                <td className="px-4 py-3">{l.suburb || '—'}</td>
                <td className="px-4 py-3 tabular-nums">{l.postcode || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
