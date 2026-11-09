import { useState } from 'react'
import { isNetworkFailure } from '../lib/saveErrors.js'
import Notice from './Notice.jsx'
import { GateButton } from '../screens/GateLayout.jsx'

// A sent report's PDF, through a link that lasts five minutes: report-file for a
// report link (D3b), the account's own access for a saved report (D3c, D4b).
// The tab is opened on the tap itself, while it still counts as one, or the
// browser blocks it as a pop-up; it's pointed at the PDF once the link comes back.
//
// `compact` is the small button for a list inside the app.
export default function OpenPdf({
  getUrl,
  hasFile,
  compact = false,
  label = 'Open the PDF',
  text = 'Open the PDF',
}) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [ready, setReady] = useState(null)

  if (!hasFile)
    return <p className="text-ink-soft text-[12.5px]">This report was sent without a PDF.</p>

  const open = async () => {
    setProblem('')
    setReady(null)
    setBusy(true)
    const tab = window.open('', '_blank')
    try {
      const url = await getUrl()
      if (tab) {
        tab.opener = null
        tab.location.replace(url)
      } else {
        setReady(url)
      }
    } catch (e) {
      tab?.close()
      setProblem(
        navigator.onLine === false || e.network || isNetworkFailure(e)
          ? 'Opening the PDF needs a connection.'
          : e.message || 'The PDF could not be opened.',
      )
    }
    setBusy(false)
  }

  return (
    <div className="space-y-2">
      {compact ? (
        <button
          type="button"
          disabled={busy}
          onClick={open}
          aria-label={label}
          className="border-hair text-navy min-h-[38px] rounded-lg border px-3 text-[13px] font-semibold enabled:hover:bg-slate-50 disabled:opacity-40"
        >
          {busy ? 'Opening…' : text}
        </button>
      ) : (
        <>
          <GateButton type="button" disabled={busy} onClick={open}>
            {busy ? 'Opening…' : 'Open the PDF'}
          </GateButton>
          <p className="text-ink-soft text-[12.5px]">
            The PDF is the full report, with every result. Save or print it from there.
          </p>
        </>
      )}
      {ready && (
        <p className="text-[13px]">
          <a
            href={ready}
            target="_blank"
            rel="noopener noreferrer"
            className="text-navy font-semibold underline"
          >
            The PDF is ready: open it
          </a>
        </p>
      )}
      {problem && <Notice blocked title={problem} />}
    </div>
  )
}
