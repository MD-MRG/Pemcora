/**
 * deliver-report — record a sent report and email its link (build plan D2).
 *
 *   { action: 'send', visitId, email, snapshot, filePath, title, appUrl }
 *   { action: 'resend', deliveryId, title, appUrl }
 *
 * "send" calls send_report(), "resend" ("Send again") calls resend_report(). The
 * app has already uploaded the PDF to reports/<team>/<uuid>.pdf, and passes its
 * path. Withdrawing a report emails nobody, so the app calls revoke_report()
 * itself.
 *
 * Deploy with `supabase functions deploy deliver-report`. It reads the same
 * secrets as send-invite: RESEND_API_KEY, INVITE_FROM and INVITE_APP_URL. Without
 * RESEND_API_KEY the report is still sent (it's a row in the database, and its
 * link works) and the link comes back with `emailed: false` for the app to hand
 * over, as send-invite does.
 *
 * Authorisation is not re-implemented here. Both calls run with the caller's own
 * login token, so the database decides: the visit is the caller's team's and
 * finished, the file is in the team's folder, no note still says [timeframe],
 * and the team is under its daily cap (0011). The service-role key is never
 * used. Every name, address and date in the email comes from the row the
 * database wrote, and "Send again" goes to the address the report was first
 * sent to, never one in the request. Only the report's title is the app's.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { json, preflight, appBaseUrl } from '../_shared/cors.ts'
import { emailBody, fromLine, refusal, replyTo, reportLink } from './message.js'

type Body = {
  action?: string
  visitId?: string
  email?: string
  snapshot?: unknown
  filePath?: string | null
  deliveryId?: string
  title?: string
  appUrl?: string
}

Deno.serve(async req => {
  const pre = preflight(req)
  if (pre) return pre

  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'Not authenticated' }, 401)

  let body: Body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Expected a JSON body' }, 400)
  }
  if (body.action !== 'send' && body.action !== 'resend') {
    return json({ error: "Expected action 'send' or 'resend'" }, 400)
  }

  const base = appBaseUrl(req, body.appUrl)
  if (!base) {
    return json({ error: 'Set INVITE_APP_URL on this function so it knows where the link should point.' }, 400)
  }

  const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authorization } },
  })

  const { data: row, error } =
    body.action === 'resend'
      ? await caller.rpc('resend_report', { p_delivery_id: body.deliveryId })
      : await caller.rpc('send_report', {
          p_visit_id: body.visitId,
          p_recipient_email: body.email,
          p_snapshot: body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : {},
          p_file_path: body.filePath ?? null,
        })
  if (error) {
    const r = refusal(error)
    return json(r.body, r.status)
  }

  const link = reportLink(base, row.token)
  const sent = { id: row.id, link, email: row.recipient_email, expiresAt: row.link_expires_at }

  const key = Deno.env.get('RESEND_API_KEY')
  if (!key) return json({ ...sent, emailed: false, reason: 'no-mailer' })

  // The business as the database wrote it into the report, over anything the app sent.
  const provider = row.snapshot?.provider ?? {}
  const business = provider.company?.name || provider.name || ''
  const { data: auth } = await caller.auth.getUser()
  const reply = replyTo(provider.company?.email, auth?.user?.email)

  const message = emailBody({
    business,
    title: body.title,
    site: row.site,
    completedOn: row.completed_on,
    link,
    expiresAt: row.link_expires_at,
    reply,
  })
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromLine(Deno.env.get('INVITE_FROM'), business),
      to: [row.recipient_email],
      ...(reply ? { reply_to: reply } : {}),
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  })

  if (!res.ok) {
    // The report is sent all the same, and counted: it's the row, not the email.
    // Hand back the link so it can still reach them.
    const detail = await res.text()
    return json({ ...sent, emailed: false, reason: detail.slice(0, 300) })
  }

  return json({ ...sent, emailed: true })
})
