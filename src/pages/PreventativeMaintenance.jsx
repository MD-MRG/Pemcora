import WorkflowPage from '../workflows/WorkflowPage.jsx'

// Recurring service visits. Shares its whole workflow with Commissioning —
// only the test template and the wording differ.
const config = {
  kind: 'maintenance',
  templateKind: 'maintenance',
  title: 'Preventative Maintenance',
  progressNoun: 'Preventative Maintenance',
  startLabel: 'Start PM',
  newLabel: 'Start new visit',
  emptyLine: 'No PM recorded for this location',
  reportTitle: 'Preventative Maintenance',
}

export default function PreventativeMaintenance() {
  return <WorkflowPage config={config} />
}
