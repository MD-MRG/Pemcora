import WorkflowPage from '../workflows/WorkflowPage.jsx'
import { pageConfig } from '../data/packs/index.js'

// Handover verification. Same workflow as Preventative Maintenance, its own
// test template, and its own visit history — `kind` is what keeps the two
// apart, so a commissioning in progress never blocks or gets confused with a PM.
// The wording and the list are in src/data/packs/av.js.
const config = pageConfig('commissioning')

export default function Commissioning() {
  return <WorkflowPage config={config} />
}
