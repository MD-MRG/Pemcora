import { Link } from 'react-router-dom'
import WorkflowPage from '../workflows/WorkflowPage.jsx'
import { getTemplate } from '../lib/templateStore.js'

// A one-off list the technician builds themselves — a site with equipment the
// standard lists do not cover, a commissioning against a client's own
// checklist, a fault-finding sweep.
//
// The same workflow as Preventative Maintenance and Commissioning, with its own
// `kind` so its visits never mix with theirs, and its own template.
const config = {
  kind: 'custom',
  templateKind: 'custom',
  title: 'Custom List',
  progressNoun: 'Custom list',
  startLabel: 'Start custom list',
  newLabel: 'Start new custom list',
  emptyLine: 'No custom list recorded for this location',
  reportTitle: 'Custom List',
}

// The one way this workflow genuinely differs: its template seeds EMPTY, where
// Maintenance and Commissioning arrive with ~60 tests from the spreadsheets. So
// it is the only one that can be legitimately unconfigured, and walking someone
// through picking a client and starting a visit only to hand them a room with
// nothing to fill in is a dead end. Say so at the door instead.
const isUnbuilt = template =>
  (template?.tests?.length ?? 0) === 0 && (template?.sections?.length ?? 0) === 0

export default function CustomList() {
  const template = getTemplate('custom')

  if (isUnbuilt(template)) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="border-hair rounded-xl border bg-card p-6">
          <h2 className="text-ink text-[16px] font-semibold">Build your custom list first</h2>
          <p className="text-ink-soft mt-2 text-[13.5px] leading-relaxed">
            Unlike Preventative Maintenance and Commissioning, this list starts empty — it is
            whatever your job needs. Add the tests and name the sections, and this page becomes the
            same workflow as the other two.
          </p>
          <Link
            to="/settings"
            className="bg-navy mt-5 inline-flex min-h-[46px] items-center rounded-lg px-5 text-[13.5px] font-semibold text-white hover:bg-[#24486e]"
          >
            Open Settings
          </Link>
        </div>
      </div>
    )
  }

  return <WorkflowPage config={config} />
}
