import { useState } from 'react'
import { assetFields, assetTypeLabel, assetTypeNoun } from '../data/packs/shared/assetTypes.js'
import { expiryFrom } from '../lib/equipment.js'

// Adding or editing one item of equipment: the columns every item has, then its
// type's own fields (assets.attributes). Entering a smoke alarm's manufacture
// date fills in its expiry, which stays editable; a later change to the date
// moves an expiry that was worked out from it, and leaves a typed one alone.
//
//   asset    the item, or { assetType } for a new one, with anything to start from
//   name     what the form is called, when it isn't "New smoke alarm" or "Edit …"
//   children more buttons, beside Cancel: the panel's Replace and Remove
//   onSave(patch)   every field, blanks as null; attributes keep any this form
//                   doesn't know about
export default function ItemForm({ asset, rooms, name, saveLabel, onSave, onCancel, children }) {
  const type = asset.assetType
  const fields = assetFields(type)
  const [form, setForm] = useState(() => ({
    label: asset.label ?? '',
    roomId: asset.roomId ?? '',
    make: asset.make ?? '',
    model: asset.model ?? '',
    serial: asset.serial ?? '',
    installedOn: asset.installedOn ?? '',
    expiresOn: asset.expiresOn ?? '',
  }))
  const [attributes, setAttributes] = useState(() => ({ ...(asset.attributes ?? {}) }))
  const set = key => value => setForm(f => ({ ...f, [key]: value }))

  const setAttribute = (field, value) => {
    setAttributes(a => ({ ...a, [field.id]: value }))
    if (field.id !== 'manufactured') return
    const before = expiryFrom(attributes.manufactured, type)
    const after = expiryFrom(value, type)
    setForm(f => (!f.expiresOn || f.expiresOn === before ? { ...f, expiresOn: after ?? '' } : f))
  }

  const save = () => {
    const kept = Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== '' && v != null))
    onSave({
      label: form.label.trim(),
      roomId: form.roomId || null,
      make: form.make.trim(),
      model: form.model.trim(),
      serial: form.serial.trim(),
      installedOn: form.installedOn || null,
      expiresOn: form.expiresOn || null,
      attributes: kept,
    })
  }

  const what = assetTypeLabel(type)
  return (
    <form
      className="border-hair border-t bg-slate-50 px-4 py-3"
      aria-label={name ?? (asset.id ? `Edit ${asset.label || assetTypeNoun(type)}` : `New ${assetTypeNoun(type)}`)}
      onSubmit={e => {
        e.preventDefault()
        save()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Name" value={form.label} onChange={set('label')} placeholder={`e.g. ${what} by the front door`} autoFocus />
        <Labelled label="Room">
          <select value={form.roomId} onChange={e => set('roomId')(e.target.value)} className={INPUT}>
            <option value="">Not in a room</option>
            {rooms.map(r => (
              <option key={r.id} value={r.id}>
                {[r.name || 'Unnamed room', r.floorLabel].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </Labelled>

        {fields.map(field => (
          <TypeField key={field.id} field={field} value={attributes[field.id]} onChange={v => setAttribute(field, v)} />
        ))}

        <Input label="Make" value={form.make} onChange={set('make')} />
        <Input label="Model" value={form.model} onChange={set('model')} />
        <Input label="Serial number" value={form.serial} onChange={set('serial')} />
        <Input label="Installed" type="date" value={form.installedOn} onChange={set('installedOn')} />
        <Input label="Expires" type="date" value={form.expiresOn} onChange={set('expiresOn')} />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {children && <div className="mr-auto flex flex-wrap gap-2">{children}</div>}
        <button
          type="button"
          onClick={onCancel}
          className="border-hair text-ink-soft min-h-[40px] rounded-lg border bg-white px-3 text-[13px] font-semibold hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="bg-navy min-h-[40px] rounded-lg px-4 text-[13px] font-semibold text-white hover:bg-[#24486e]"
        >
          {saveLabel}
        </button>
      </div>
    </form>
  )
}

const INPUT =
  'border-hair text-ink focus:border-navy w-full rounded-lg border bg-white px-3 py-2 text-[14px] outline-none'

function Labelled({ label, children }) {
  return (
    <label className="block">
      <span className="text-ink-soft mb-1 block text-[12.5px] font-semibold">{label}</span>
      {children}
    </label>
  )
}

function Input({ label, value, onChange, type = 'text', ...rest }) {
  return (
    <Labelled label={label}>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} className={INPUT} {...rest} />
    </Labelled>
  )
}

// One of the type's own fields. A blank choice is "not recorded", which is not
// the same as No.
function TypeField({ field, value, onChange }) {
  if (field.type === 'choice' || field.type === 'yesno') {
    const options = field.type === 'yesno' ? [['yes', 'Yes'], ['no', 'No']] : field.options
    const shown = field.type === 'yesno' ? (value === true ? 'yes' : value === false ? 'no' : '') : (value ?? '')
    return (
      <Labelled label={field.label}>
        <select
          value={shown}
          onChange={e => {
            const v = e.target.value
            onChange(field.type === 'yesno' ? (v === 'yes' ? true : v === 'no' ? false : '') : v)
          }}
          className={INPUT}
        >
          <option value="">Not recorded</option>
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      </Labelled>
    )
  }
  return <Input label={field.label} type={field.type === 'date' ? 'date' : 'text'} value={value ?? ''} onChange={onChange} />
}
