// The devices signed in to your account (build plan C5). Pure, so it runs in
// Node as well.

// Most specific first: Edge and Opera also say Chrome, and Chrome also says Safari.
const BROWSERS = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]
const SYSTEMS = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'Chromebook'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Linux/, 'Linux'],
]

const first = (list, text) => list.find(([re]) => re.test(text))?.[1] ?? null

/** "Safari on iPhone", "Edge on Windows", from a login's browser details. */
export function deviceName(userAgent) {
  const ua = String(userAgent ?? '')
  const browser = first(BROWSERS, ua)
  const system = first(SYSTEMS, ua)
  if (browser && system) return `${browser} on ${system}`
  return browser ?? (system ? `A browser on ${system}` : 'An unknown device')
}

/**
 * Which login a token belongs to: the `session_id` its login token carries.
 * Null for anything that isn't one. Read only to say "This device", never trusted
 * for anything: the database checks whose login is whose itself.
 */
export function sessionIdOf(accessToken) {
  try {
    const part = String(accessToken ?? '').split('.')[1]
    if (!part) return null
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    return JSON.parse(atob(base64)).session_id ?? null
  } catch {
    return null
  }
}

/** This device first, then the rest as the database ordered them, by when last used. */
export const thisDeviceFirst = (devices, currentId) => [
  ...devices.filter(d => d.id === currentId),
  ...devices.filter(d => d.id !== currentId),
]
