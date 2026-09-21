import 'server-only'

import { databaseConfig } from './config'

/** Why a page could not load its data. Never shown to a visitor verbatim. */
export type UnavailableReason = 'not-configured' | 'unreachable'

/** The outcome of a page's data load: the data, or why the page cannot show it. */
export type Loaded<T> = { ok: true; value: T } | { ok: false; reason: UnavailableReason }

/**
 * Runs a page's data load and turns a database failure into a value the page can
 * render.
 *
 * Why this exists instead of an error boundary: Next.js renders `error.tsx` only
 * in the browser, so a server-side failure reaches the visitor as a `500` whose
 * HTML carries no visible content. The browser then shows its own error page, and
 * there is nothing on screen to explain or diagnose. Catching the failure here
 * produces real HTML, a real explanation, and a page the operator can act on.
 *
 * The error is never swallowed: it is logged in full, server-side, with the
 * label of the load that failed.
 */
export async function loadOrUnavailable<T>(label: string, work: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    console.error(`[data] ${label} could not be loaded:`, error)
    return { ok: false, reason: databaseConfig.configured ? 'unreachable' : 'not-configured' }
  }
}
