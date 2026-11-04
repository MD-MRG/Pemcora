// Puts the signed-in devices list on the page by itself, for tests/devices.mjs.
// The real one only renders with a session, and the suites run without one.
// Served by the dev server; nothing in src/ imports it, so it never reaches a build.
import { createRoot } from 'react-dom/client'
import SignedInDevices from '../../src/components/SignedInDevices.jsx'

let root = null

// `fail`: the message signing out throws, if it should.
export function mountDevices(props, { fail = null } = {}) {
  const calls = (window.__deviceCalls = [])
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  root?.unmount()
  root = createRoot(host)
  root.render(
    <SignedInDevices
      {...props}
      onEnd={async device => {
        calls.push(['end', device.id])
        if (fail) throw new Error(fail)
      }}
      onEndOthers={async () => {
        calls.push(['others'])
        if (fail) throw new Error(fail)
      }}
    />,
  )
}
