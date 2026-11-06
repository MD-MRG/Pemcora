/**
 * The parts of deliver-report that decide what's said and to whom: no Deno and
 * no network, so tests/deliver-report.mjs runs them in Node. Plain JavaScript,
 * which Deno imports as it is.
 *
 * Every name and address here was typed by somebody (the business name in
 * Settings, the report title the app passes), so each one is made a single
 * short line before it reaches a header, and escaped before it reaches HTML.
 */

export const escapeHtml = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// One line, no control characters, at most `max` characters: nothing typed can
// add a header or a paragraph of its own.
export const oneLine = (s, max = 80) =>
  String(s ?? '')
    // oxlint-disable-next-line no-control-regex -- matching them is the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()

export const isEmail = s => typeof s === 'string' && /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/.test(s.trim())

// The address in INVITE_FROM, which is either "Name <address>" or the address.
export function senderAddress(from) {
  const text = String(from ?? '').trim()
  const named = /<([^<>]+)>$/.exec(text)
  const address = named ? named[1].trim() : text
  return isEmail(address) ? address : null
}

// From Pemcora's own address, so the email is Pemcora's to send and its domain's
// to vouch for, but named after the business, which is who the landlord knows.
// Quotes, brackets and backslashes would end the name early, so they go.
export function fromLine(from, business) {
  const address = senderAddress(from) ?? 'onboarding@resend.dev'
  const name = oneLine(business, 60).replace(/["<>\\]/g, '').trim()
  return `"${name ? `${name} via Pemcora` : 'Pemcora'}" <${address}>`
}

// Replies go to the business: the email in its Settings, or failing that the
// person who sent the report. Never to Pemcora, which can't answer them.
export function replyTo(companyEmail, senderEmail) {
  for (const e of [companyEmail, senderEmail]) if (isEmail(e)) return e.trim()
  return null
}

export const reportLink = (base, token) => `${base}#/r/${encodeURIComponent(token)}`

// "10 Smith St, Richmond VIC 3121": the address the database copied from the site.
export function siteLine(site) {
  const s = site ?? {}
  const place = [s.suburb ?? s.city, s.state, s.postcode].map(p => oneLine(p, 40)).filter(Boolean).join(' ')
  return [oneLine(s.address, 80), place].filter(Boolean).join(', ')
}

// "6 November 2026". A date on its own is written as it is; a moment in time as
// the day it falls on in Sydney, which is how the database dates visits
// (local_day in 0006).
export function longDate(value) {
  if (!value) return ''
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const at = new Date(day ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: day ? 'UTC' : 'Australia/Sydney',
  })
}

/**
 * A refusal from send_report() or resend_report(), as the app hears it. The
 * code and hint go back with the message: they're how the app tells the daily
 * cap ('send_cap') and an unfinished note ('unfinished') from any other refusal.
 * The cap is a 429, like any rate limit.
 */
export function refusal(error) {
  return {
    status: error?.code === 'PT429' ? 429 : 400,
    body: { error: error?.message || 'The report could not be sent.', code: error?.code ?? null, hint: error?.hint ?? null },
  }
}

/**
 * The email. Everything in it comes from the delivery the database wrote (the
 * business, the site, the date, the link's expiry), except the report's title,
 * which the app passes and which is cut to one line.
 */
export function emailBody({ business, title, site, completedOn, link, expiresAt, reply }) {
  const who = oneLine(business, 60) || 'Your electrician'
  const what = oneLine(title, 80) || 'report'
  const where = siteLine(site)
  const done = longDate(completedOn)
  const until = longDate(expiresAt)

  const opening = `${who} has sent you the ${what}${where ? ` for ${where}` : ''}${done ? `, done on ${done}` : ''}.`
  const lasts = `The link works until ${until || 'it expires'}. After that, ask ${who} for a new one.`
  const keep = 'You can save the report to a free Pemcora account to keep it, and later reports for the same property file themselves.'
  const answer = reply ? `Questions about the report? Reply to this email to reach ${who}.` : ''
  const footer = `Sent by Pemcora for ${who}. If you weren't expecting this report, you can ignore this email.`

  const h = escapeHtml
  return {
    subject: `${who}: ${what}${where ? ` for ${where}` : ''}`,
    text: [opening, '', 'Open the report:', link, '', lasts, keep, ...(answer ? ['', answer] : []), '', footer].join('\n'),
    html: `<!doctype html><html><body style="margin:0;background:#f4f6f8;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16283b">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e8ee;border-radius:12px;padding:28px">
    <p style="margin:0 0 4px;font-size:13px;color:#5b7085">${h(who)} via Pemcora</p>
    <h1 style="margin:0 0 16px;font-size:19px">${h(what.charAt(0).toUpperCase() + what.slice(1))}${where ? ` for ${h(where)}` : ''}</h1>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.55">${h(opening)}</p>
    <p style="margin:0 0 24px"><a href="${h(link)}" style="display:inline-block;background:#1b3a5c;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px">Open the report</a></p>
    <p style="margin:0 0 8px;font-size:12.5px;color:#5b7085">Or paste this into your browser:</p>
    <p style="margin:0 0 24px;font-size:12px;word-break:break-all;color:#5b7085">${h(link)}</p>
    <p style="margin:0 0 12px;font-size:13px;line-height:1.55">${h(lasts)} ${h(keep)}</p>
    ${answer ? `<p style="margin:0 0 20px;font-size:13px;line-height:1.55">${h(answer)}</p>` : ''}
    <p style="margin:0;font-size:12.5px;color:#5b7085;border-top:1px solid #e3e8ee;padding-top:16px">${h(footer)}</p>
  </div>
</body></html>`,
  }
}
