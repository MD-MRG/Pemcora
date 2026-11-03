import WorkflowPage from '../workflows/WorkflowPage.jsx'
import { pageConfig } from '../data/packs/index.js'

// Recurring service visits. Shares its whole workflow with Commissioning —
// only the test template and the wording differ (both in src/data/packs/av.js).
const config = pageConfig('maintenance')

export default function PreventativeMaintenance() {
  return <WorkflowPage config={config} />
}
