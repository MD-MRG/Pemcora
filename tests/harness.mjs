/**
 * Shared setup for the browser suites.
 *
 * Since the app grew an auth gate, navigating to it lands on a sign-in screen
 * and every suite times out waiting for a nav that never renders. `testContext`
 * creates a Playwright context that sets the `fc.testMode` flag before any page
 * script runs, which makes the app bypass the gate and keep the stores on
 * localStorage — exactly the behaviour these suites were written against.
 *
 * `addInitScript` rather than a `page.evaluate` after loading: the flag has to
 * exist before the app's modules read it, and evaluate runs too late.
 *
 * The flag is only honoured by a dev build (`import.meta.env.DEV`), so it can
 * do nothing at all to the deployed site — see src/lib/supabase.js.
 */
export async function testContext(browser, options = {}) {
  const ctx = await browser.newContext(options)
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('fc.testMode', '1')
    } catch {
      /* storage unavailable — the suite will fail loudly at the gate instead */
    }
  })
  return ctx
}
