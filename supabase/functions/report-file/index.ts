/**
 * report-file — a link to a sent report's PDF, good for five minutes (build
 * plan D3b, 2.10).
 *
 *   { token }  →  { url, expiresIn }
 *
 * For the report link page, whose visitor usually has no Pemcora account. The
 * link's token is the key, as the emailed link is: the PDF is given only while
 * report_preview() would show the report (not saved to an account, not past its
 * 90 days). A saved report is downloaded by its account, signed in, through the
 * bucket's own rules; this function never serves one.
 *
 * Deploy with `supabase functions deploy report-file --no-verify-jwt`. The
 * visitor has no login, and the app's publishable key isn't a JWT, so the
 * platform's own login check would turn every visitor away. No secrets to set:
 * the service-role key is provided by the platform, and it never leaves here.
 * It reads one row, by token, and only the columns in access.js, then signs that
 * one file. Nothing else can be asked of it: there's no path, team or id in the
 * request.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { json, preflight } from '../_shared/cors.ts'
import { COLUMNS, LINK_SECONDS, UUID, fileAccess } from './access.js'

Deno.serve(async req => {
  const pre = preflight(req)
  if (pre) return pre
  if (req.method !== 'POST') return json({ error: 'Expected POST' }, 405)

  let body: { token?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Expected a JSON body' }, 400)
  }
  const token = String(body?.token ?? '').toLowerCase()
  if (!UUID.test(token)) return json({ status: 'invalid', error: "That report link isn't valid." }, 400)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: row, error } = await admin.from('report_deliveries').select(COLUMNS).eq('token', token).maybeSingle()
  if (error) return json({ error: 'The report could not be looked up. Try again in a moment.' }, 500)

  const access = fileAccess(row)
  if (!access.ok) return json(access.body, access.status)

  const { data: signed, error: failed } = await admin.storage.from('reports').createSignedUrl(access.path, LINK_SECONDS)
  if (failed || !signed?.signedUrl) return json({ status: 'no-file', error: "The report's PDF could not be found." }, 404)

  return json({ url: signed.signedUrl, expiresIn: LINK_SECONDS })
})
