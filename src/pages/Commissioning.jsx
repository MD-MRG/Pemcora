import WorkflowPage from '../workflows/WorkflowPage.jsx'

// Handover verification. Same workflow as Preventative Maintenance, its own
// test template, and its own visit history — `kind` is what keeps the two
// apart, so a commissioning in progress never blocks or gets confused with a PM.
const config = {
  kind: 'commissioning',
  templateKind: 'commissioning',
  title: 'Commissioning',
  progressNoun: 'Commissioning',
  startLabel: 'Start commissioning',
  newLabel: 'Start new commissioning',
  emptyLine: 'No commissioning recorded for this location',
  reportTitle: 'Commissioning',
}

export default function Commissioning() {
  return <WorkflowPage config={config} />
}
