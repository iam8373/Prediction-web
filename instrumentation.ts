/**
 * Next.js runs `register()` once per server start, before the first request.
 *
 * It is used for exactly one thing: writing the configuration report (see
 * `lib/config/startup.ts`) into the deploy logs, so a deployment that is
 * missing a required environment variable says so immediately instead of
 * failing later with an opaque 500.
 *
 * The check on `NEXT_RUNTIME` is required: this file is also evaluated for the
 * edge runtime, where the Node-only environment inspection does not apply.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    const { logStartupConfiguration } = await import('./lib/config/startup')
    await logStartupConfiguration()
  } catch (error) {
    // Never block startup: the report is diagnostics, not a dependency.
    console.error('[config] could not write the startup configuration report:', error)
  }
}
