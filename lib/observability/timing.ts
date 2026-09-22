import 'server-only'

/**
 * Server-side timing for the data loads a page waits on.
 *
 * A page that feels slow should say why in the deploy logs, not in a guess. Every
 * wrapped load logs its duration, and anything at or over the slow threshold is
 * logged as a warning so a regression stands out:
 *
 *   [timing] markets.list 42ms
 *   [timing] market.detail SLOW 812ms
 *
 * The threshold is `SLOW_LOAD_MS` (default 250ms). One line per data load is a
 * deliberate trade: it is the difference between "the market page felt slow for
 * two days" and knowing which of its four queries needed an index.
 *
 * Nothing here is a security boundary and nothing here logs user data — only the
 * label the caller chose and a duration.
 */

const DEFAULT_SLOW_MS = 250

function slowThresholdMs(): number {
  const configured = Number.parseInt(process.env.SLOW_LOAD_MS ?? '', 10)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SLOW_MS
}

export async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await work()
  } finally {
    // Logged in `finally` so a load that fails is still accounted for; a failure
    // that took eight seconds is exactly the thing worth seeing.
    const elapsed = Math.round(performance.now() - started)
    if (elapsed >= slowThresholdMs()) {
      console.warn(`[timing] ${label} SLOW ${elapsed}ms`)
    } else {
      console.info(`[timing] ${label} ${elapsed}ms`)
    }
  }
}
