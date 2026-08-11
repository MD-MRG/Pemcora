// The app is served from github.io and the functions from supabase.co, so every
// call is cross-origin and every one of them is preceded by a preflight.
//
// `*` is safe here only because both functions require a JWT: Supabase verifies
// it before the handler runs, and neither one trusts a cookie for anything. A
// page on another origin can reach these endpoints, but not with anybody's
// credentials.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

export const preflight = (req: Request) =>
  req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null

/**
 * Where the invitation link should point.
 *
 * INVITE_APP_URL wins, and on a real deployment it is what you should set —
 * GitHub Pages serves the app from a sub-path, so the Origin header alone
 * ("https://md-mrg.github.io") would produce a link to a page that does not
 * exist.
 *
 * Failing that, the caller's own address is accepted, but only when it sits
 * under the Origin the browser reported. Origin is set by the browser and
 * cannot be forged by page script, so this ties the link to the site that
 * actually made the call rather than to whatever the request body claimed.
 */
export function appBaseUrl(req: Request, claimed: unknown): string | null {
  const configured = Deno.env.get('INVITE_APP_URL')
  if (configured) return configured.endsWith('/') ? configured : configured + '/'

  const origin = req.headers.get('origin')
  const asked = typeof claimed === 'string' ? claimed : ''
  if (origin && asked.startsWith(origin + '/')) return asked
  return null
}
