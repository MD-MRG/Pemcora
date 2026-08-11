/**
 * send-invite — create an invitation and email the link.
 *
 * Deploy with `supabase functions deploy send-invite`, then set RESEND_API_KEY
 * and INVITE_FROM as function secrets. Until RESEND_API_KEY exists the function
 * still works: it creates the invitation, reports `emailed: false`, and hands
 * the link back for the Teams page to offer as copy-to-clipboard. That is the
 * same behaviour the app had before this function existed, so deploying it
 * half-configured degrades rather than breaks.
 *
 * Authorisation is not re-implemented here. The invitation is created with the
 * caller's own JWT, so create_invite's `is_team_admin` check is what decides —
 * the service-role key is never used to mint one. A function that checked
 * permissions itself would be a second copy of a rule that already exists in
 * the database, and second copies drift.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { json, preflight, appBaseUrl } from '../_shared/cors.ts'

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

function emailBody(teamName: string, link: string, invitedBy: string) {
  const team = escapeHtml(teamName)
  const who = escapeHtml(invitedBy)
  return {
    subject: `${invitedBy} has invited you to ${teamName} on Pemcora`,
    text: [
      `${invitedBy} has invited you to join ${teamName} on Pemcora.`,
      '',
      'Open this link to create your account:',
      link,
      '',
      'You will be asked to set a password and then to confirm your email address.',
      'Confirming it is what puts you in the team.',
      '',
      'The link is good for one week and can be used once. If it expires, ask',
      `${invitedBy} to send you another.`,
    ].join('\n'),
    html: `<!doctype html><html><body style="margin:0;background:#f4f6f8;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#16283b">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e8ee;border-radius:12px;padding:28px">
    <p style="margin:0 0 4px;font-size:13px;color:#5b7085">Pemcora · AV Service</p>
    <h1 style="margin:0 0 16px;font-size:19px">You have been invited to ${team}</h1>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.55">${who} has invited you to join <b>${team}</b>. Create your account, then confirm your email address — confirming it is what puts you in the team.</p>
    <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#1b3a5c;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px">Create your account</a></p>
    <p style="margin:0 0 8px;font-size:12.5px;color:#5b7085">Or paste this into your browser:</p>
    <p style="margin:0 0 24px;font-size:12px;word-break:break-all;color:#5b7085">${escapeHtml(link)}</p>
    <p style="margin:0;font-size:12.5px;color:#5b7085;border-top:1px solid #e3e8ee;padding-top:16px">The link is good for one week and can be used once. If it expires, ask ${who} to send you another. If you were not expecting this, ignore it — nothing happens until you create an account.</p>
  </div>
</body></html>`,
  }
}

Deno.serve(async req => {
  const pre = preflight(req)
  if (pre) return pre

  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'Not authenticated' }, 401)

  let body: { teamId?: string; email?: string; appUrl?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Expected a JSON body' }, 400)
  }

  const base = appBaseUrl(req, body.appUrl)
  if (!base) {
    return json(
      { error: 'Set INVITE_APP_URL on this function so it knows where the link should point.' },
      400,
    )
  }

  // The caller's own token, deliberately: create_invite decides whether they
  // may do this, exactly as it does when the page calls it directly.
  const caller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authorization } } },
  )

  const { data: invite, error } = await caller.rpc('create_invite', {
    p_team_id: body.teamId,
    p_email: body.email,
  })
  if (error) return json({ error: error.message }, 400)

  const link = `${base}?invite=${encodeURIComponent(invite.token)}`

  const { data: team } = await caller.from('teams').select('name').eq('id', body.teamId).single()
  const { data: auth } = await caller.auth.getUser()
  const teamName = team?.name ?? 'a team'
  const invitedBy = auth?.user?.email ?? 'A colleague'

  const key = Deno.env.get('RESEND_API_KEY')
  if (!key) {
    // Not an error. The invitation is real and the link works; only delivery is
    // missing, and the page can hand it over by hand.
    return json({ link, emailed: false, reason: 'no-mailer', email: invite.email })
  }

  const message = emailBody(teamName, link, invitedBy)
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('INVITE_FROM') ?? 'Pemcora <onboarding@resend.dev>',
      to: [invite.email],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  })

  if (!res.ok) {
    // The invitation still stands — it is a row in the database, not an email.
    // Say what went wrong and hand back the link so the invitation is not lost
    // just because the mailer was.
    const detail = await res.text()
    return json({ link, emailed: false, reason: detail.slice(0, 300), email: invite.email })
  }

  return json({ link, emailed: true, email: invite.email }, 200)
})
