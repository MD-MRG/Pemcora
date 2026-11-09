import { useCallback, useEffect, useState } from 'react'
import {
  deliveryByToken,
  receivedByToken,
  previewReport,
  receivingTeams,
  reportFileUrl,
  savedReportFileUrl,
} from '../lib/api.js'
import { useAuth } from '../context/auth.js'
import AuthScreen from '../screens/AuthScreen.jsx'
import SaveReport, { FileReport, Saved } from './SaveReport.jsx'
import { isNetworkFailure } from '../lib/saveErrors.js'
import {
  receivedAsPreview,
  rememberReport,
  reportSummary,
  reportTokenFrom,
} from '../lib/reportLink.js'
import OpenPdf from '../components/OpenPdf.jsx'
import Notice from '../components/Notice.jsx'
import GateLayout, { GateButton } from '../screens/GateLayout.jsx'

// What a report link `#/r/<token>` opens (build plan D3, 2.10). It's shown to
// whoever holds the link, signed in or not, so the app puts it in front of the
// sign-in gate. The link is the key, as an emailed PDF would be: report_preview()
// decides what it shows, and gives the report itself only while the link works
// and nobody has saved it.

const leave = () => {
  window.location.hash = '#/'
}

function Row({ label, children }) {
  if (!children) return null
  return (
    <div className="border-hair flex flex-wrap gap-x-4 gap-y-0.5 border-b py-2 last:border-0">
      <dt className="text-ink-soft w-32 shrink-0 text-[12.5px] font-semibold">{label}</dt>
      <dd className="text-ink min-w-0 flex-1 text-[13.5px]">{children}</dd>
    </div>
  )
}

function Report({ preview, getUrl }) {
  const r = reportSummary(preview)
  return (
    <div className="space-y-5">
      <div>
        <p className="text-ink text-[15px] font-semibold">{r.business}</p>
        {r.contact.length > 0 && (
          <p className="text-ink-soft mt-0.5 text-[12.5px]">{r.contact.join(' · ')}</p>
        )}
      </div>

      <dl className="m-0">
        <Row label="Address">{r.site}</Row>
        <Row label="Client">{r.client}</Row>
        <Row label="Done on">{r.completedOn}</Row>
        <Row label="Outcome">
          {r.outcome && (
            <span
              className={
                r.outcome === 'Compliant' ? 'text-pass font-semibold' : 'text-fail font-semibold'
              }
            >
              {r.outcome}
            </span>
          )}
        </Row>
        <Row label="Signed off by">{r.signedBy}</Row>
        {!r.signedBy && <Row label="Technician">{r.technician}</Row>}
        <Row label="Revision">
          {r.revision && `Revision ${r.revision}, replacing the one before`}
        </Row>
      </dl>

      <section>
        <h2 className="text-ink-soft mb-2 text-[11.5px] font-semibold tracking-[.08em] uppercase">
          {r.issues.length ? `Issues found (${r.issues.length})` : 'Issues found'}
        </h2>
        {r.issues.length === 0 ? (
          <p className="text-ink text-[13.5px]">None.</p>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {r.issues.map((issue, i) => (
              <li key={i} className="border-fail/25 bg-fail/5 rounded-lg border px-3 py-2">
                <p className="text-ink text-[13.5px] font-semibold">
                  {issue.where}: {issue.label}
                  {issue.mustReplace && <span className="text-fail"> · must be replaced</span>}
                </p>
                {issue.note && <p className="text-ink-soft mt-0.5 text-[13px]">{issue.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <OpenPdf getUrl={getUrl} hasFile={r.hasFile} />
    </div>
  )
}

/**
 * A saved report, for whoever signs in (D3c). Its own account sees it, its PDF
 * through the bucket's rules, and can file it if it isn't yet. Anyone else is
 * told it went to another account.
 */
function SavedReport({ token, onSignIn }) {
  const { session, signOut } = useAuth()
  const [state, setState] = useState({ loading: true })
  const [filed, setFiled] = useState(undefined)

  useEffect(() => {
    if (!session) return
    let alive = true
    // Theirs through received_reports() (0013), without the sender's ids; failing
    // that, the team that sent it reads its own row.
    Promise.all([receivedByToken(token), receivingTeams()])
      .then(async ([received, teams]) => {
        const team = received && teams.find(t => t.id === received.recipient_team_id)
        const delivery = received ?? (await deliveryByToken(token))
        if (alive) setState({ delivery, team })
      })
      .catch(e => alive && setState({ error: e.message || 'The report could not be loaded.' }))
    return () => {
      alive = false
    }
  }, [session, token])

  if (!session) {
    return (
      <div className="space-y-4">
        <p className="text-ink-soft text-[13.5px]">
          Sign in with the email it was sent to, to view it and download the PDF.
        </p>
        <GateButton type="button" onClick={onSignIn}>
          Sign in
        </GateButton>
      </div>
    )
  }
  if (state.loading) {
    return (
      <p className="text-ink-soft text-[13px]" role="status">
        Opening it from your account…
      </p>
    )
  }
  if (state.error) return <Notice blocked title={state.error} />

  const { delivery, team } = state
  if (!team) {
    return (
      <div className="space-y-4">
        <p className="text-ink-soft text-[13.5px]">
          {delivery
            ? 'Your team sent this report, and the person it went to has saved it.'
            : 'It was saved to an account you aren’t signed in to. Sign in with the email it was sent to.'}
        </p>
        {!delivery && (
          <GateButton type="button" onClick={signOut}>
            Sign out
          </GateButton>
        )}
      </div>
    )
  }

  const where =
    filed !== undefined ? filed : delivery.recipient_location_id ? 'one of its properties' : null
  return (
    <div>
      <Report
        preview={receivedAsPreview(delivery)}
        getUrl={() => savedReportFileUrl(delivery.file_path)}
      />
      <div className="border-hair mt-6 border-t pt-5">
        {filed === undefined && !delivery.recipient_location_id ? (
          <FileReport team={team} delivery={delivery} onDone={setFiled} />
        ) : (
          <Saved team={team} where={where} />
        )}
      </div>
    </div>
  )
}

export default function ReportLink({ hash }) {
  const token = reportTokenFrom(hash)
  const [state, setState] = useState({ loading: true })
  const { session } = useAuth()
  // Signing in or up to save the report: the whole page, until there's a session.
  const [auth, setAuth] = useState(null)
  const startAuth = mode => {
    rememberReport(token)
    setAuth(mode)
  }

  const load = useCallback(async () => {
    if (!token) return setState({ preview: null })
    setState({ loading: true })
    try {
      setState({ preview: await previewReport(token) })
    } catch (e) {
      setState({ error: e, offline: navigator.onLine === false || isNetworkFailure(e) })
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const footer = (
    <button
      type="button"
      onClick={leave}
      className="text-navy font-semibold underline-offset-2 hover:underline"
    >
      Go to Pemcora
    </button>
  )

  if (auth && !session) return <AuthScreen report={{ mode: auth, onBack: () => setAuth(null) }} />

  if (state.loading) {
    return (
      <div className="bg-stage flex min-h-dvh items-center justify-center">
        <p className="text-ink-soft text-[13.5px]" role="status">
          Opening the report…
        </p>
      </div>
    )
  }

  if (state.error) {
    return (
      <GateLayout title="The report couldn't be opened" footer={footer}>
        <div className="space-y-4">
          <Notice
            blocked
            title={state.offline ? 'Opening a report needs a connection.' : state.error.message}
          />
          <GateButton type="button" onClick={load}>
            Try again
          </GateButton>
        </div>
      </GateLayout>
    )
  }

  const { preview } = state
  if (!preview) {
    return (
      <GateLayout title="This report link isn't valid" footer={footer}>
        <p className="text-ink-soft text-[13.5px]">
          Check that the whole link from the email was opened, or ask whoever sent the report to
          send it again.
        </p>
      </GateLayout>
    )
  }

  const from = preview.provider || 'whoever sent it'
  if (preview.status === 'expired') {
    return (
      <GateLayout title="This link has expired" footer={footer}>
        <p className="text-ink-soft text-[13.5px]">
          Report links work for 90 days. Ask {from} to send it again: a new link takes them a
          moment.
        </p>
        <SaveReport token={token} expired onAuth={startAuth} />
      </GateLayout>
    )
  }

  if (preview.status === 'saved') {
    return (
      <GateLayout
        wide={Boolean(session)}
        title="This report has been saved to a Pemcora account"
        footer={footer}
      >
        <SavedReport token={token} onSignIn={() => startAuth('sign-in')} />
      </GateLayout>
    )
  }

  const title = reportSummary(preview).check
  return (
    <GateLayout
      wide
      title={title}
      subtitle={`A report sent to you from ${reportSummary(preview).business || from}.`}
      footer={footer}
    >
      <Report preview={preview} getUrl={() => reportFileUrl(token)} />
      <SaveReport token={token} onAuth={startAuth} />
    </GateLayout>
  )
}
