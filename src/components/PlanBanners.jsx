import { useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import Notice from './Notice.jsx'
import { useEntitlements } from '../context/team.js'
import { subscribe, saveStatus } from '../lib/cache.js'
import { listClients } from '../lib/clientStore.js'
import {
  dismissUpgradeConfirmation,
  planBanners,
  subscribeEntitlements,
  upgradeConfirmation,
} from '../lib/entitlements.js'
import { openWork } from '../lib/home.js'

// Above every page, because a card that won't pay or a plan that's ending matters to
// whichever page someone is on (build plan 2.6). The link to update the card arrives
// with the customer portal, in step E4.
export default function PlanBanners() {
  const banners = planBanners(useEntitlements())
  const confirmation = useSyncExternalStore(subscribeEntitlements, upgradeConfirmation)
  // Finishing a visit should take it off the list, whichever page that happened on.
  useSyncExternalStore(subscribe, saveStatus)

  if (banners.length === 0 && !confirmation) return null

  return (
    <div className="flex flex-col gap-2 px-4 pt-4 sm:px-6 sm:pt-6">
      {confirmation && (
        <Notice title={confirmation}>
          <button
            type="button"
            onClick={dismissUpgradeConfirmation}
            className="text-navy font-semibold underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </Notice>
      )}
      {banners.map(banner =>
        banner.kind === 'cancelling' ? (
          <Cancelling key={banner.kind} title={banner.title} />
        ) : (
          <Notice key={banner.kind} blocked title={banner.title} />
        ),
      )}
    </div>
  )
}

function Cancelling({ title }) {
  const open = openWork(listClients())
  if (open.length === 0) return <Notice title={title} />
  return (
    <Notice title={`${title} Finish these open visits before then:`}>
      <ul className="m-0 list-none space-y-1 p-0">
        {open.map(row => (
          <li key={row.key}>
            <Link
              to={row.path}
              state={{ clientId: row.clientId, locationId: row.locationId }}
              className="text-navy font-semibold underline-offset-2 hover:underline"
            >
              {row.clientName}
              {row.where && ` · ${row.where}`}
            </Link>{' '}
            ({row.kindLabel})
          </li>
        ))}
      </ul>
    </Notice>
  )
}
