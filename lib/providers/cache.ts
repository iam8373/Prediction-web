import 'server-only'

/**
 * A small in-process TTL cache, used once per provider adapter.
 *
 * Why in-process and not Redis: the point is to stop a page load from becoming a
 * provider request. One entry per provider and a single-flight loader achieve
 * that on the deployment sizes this app runs at, with no extra infrastructure.
 *
 * Before real launch — and definitely before the deployment runs more than one
 * instance — this should move to a shared cache (Redis, or a small Postgres
 * table): with N instances a cold cache is refilled N times, and the provider's
 * request budget is counted per key, not per instance. Each adapter repeats that
 * note next to the TTL it chose, because the TTL only makes sense next to the
 * provider's own limits.
 */

export interface TtlCache<T> {
  /** Cached value, or the result of `load` — concurrent callers share one load. */
  getOrLoad(key: string, load: () => Promise<T>): Promise<T>
  /** Drop everything. Used by tests and the smoke script. */
  clear(): void
  readonly ttlMs: number
}

export interface TtlCacheOptions {
  /** Adapter name, used in log lines. */
  name: string
  ttlMs: number
  /** Safety valve: the keys here are few and fixed, so this is a backstop only. */
  maxEntries?: number
}

export function createTtlCache<T>(options: TtlCacheOptions): TtlCache<T> {
  const { name, ttlMs, maxEntries = 32 } = options
  const entries = new Map<string, { value: T; expiresAt: number }>()
  const inFlight = new Map<string, Promise<T>>()

  return {
    ttlMs,

    async getOrLoad(key, load) {
      const cached = entries.get(key)
      if (cached && cached.expiresAt > Date.now()) return cached.value

      // Single flight: ten concurrent page renders produce one provider call,
      // not ten. This is also what keeps a provider's per-minute limit safe
      // under a traffic spike.
      const pending = inFlight.get(key)
      if (pending) return pending

      const started = Date.now()
      const promise = load()
        .then((value) => {
          if (entries.size >= maxEntries) entries.delete(entries.keys().next().value as string)
          entries.set(key, { value, expiresAt: Date.now() + ttlMs })
          console.info(`[providers] ${name} refreshed "${key}" in ${Date.now() - started}ms`)
          return value
        })
        .finally(() => {
          inFlight.delete(key)
        })

      inFlight.set(key, promise)
      // A failure is never cached, so the next request retries instead of
      // serving an outage from cache for a whole TTL window.
      return promise
    },

    clear() {
      entries.clear()
      inFlight.clear()
    },
  }
}
