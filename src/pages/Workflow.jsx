import { useMemo } from 'react'
import WorkflowPage from '../workflows/WorkflowPage.jsx'
import { pageConfig } from '../data/packs/index.js'

// The page for any workflow that needs nothing of its own: everything it says is
// in its pack file (src/data/packs/). Preventative Maintenance, Commissioning and
// Custom List keep their own files, for the reasons given in them.
//
// Keyed by workflow, so moving from one check's page to another's never carries
// a client, site or room across.
export default function Workflow({ id }) {
  const config = useMemo(() => pageConfig(id), [id])
  return <WorkflowPage key={id} config={config} />
}
