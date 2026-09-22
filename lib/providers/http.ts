import 'server-only'

/**
 * The only HTTP plumbing the provider adapters share.
 *
 * It knows nothing about any provider: no endpoint, no credential name, no
 * response field. Each adapter keeps its own base URL, its own credential, its
 * own error class and its own parsing, so reading one adapter tells you
 * everything that provider returns.
 *
 * What it guarantees for all of them:
 *  - a hard timeout, so a slow provider cannot hold a page render open
 *  - a typed failure kind, so a bad key (401/403) is distinguishable from
 *    rate limiting (429), from a network fault, and from an unparseable body
 *  - a redacted URL in every error. Three of these providers take the key as a
 *    query parameter, and a raw URL in a log line would leak it.
 */

export type ProviderFailureKind =
  /** The credential was rejected, or the subscription does not cover this call. */
  | 'auth'
  /** The provider asked us to slow down. */
  | 'rate-limit'
  /** Any other non-2xx response. */
  | 'http'
  /** No answer inside the deadline. */
  | 'timeout'
  /** DNS, TLS or connection failure. */
  | 'network'
  /** A 2xx response whose body was not the JSON we can use. */
  | 'malformed'

export class ProviderRequestError extends Error {
  readonly kind: ProviderFailureKind
  readonly provider: string
  readonly status?: number
  /** Already redacted: safe to log, safe to put in an audit summary. */
  readonly url: string

  constructor(input: {
    kind: ProviderFailureKind
    provider: string
    url: string
    status?: number
    detail?: string
  }) {
    super(
      `${input.provider} ${input.kind} failure` +
        `${input.status ? ` (HTTP ${input.status})` : ''} on ${redactProviderUrl(input.url)}` +
        `${input.detail ? `: ${input.detail}` : ''}`,
    )
    this.name = 'ProviderRequestError'
    this.kind = input.kind
    this.provider = input.provider
    this.status = input.status
    this.url = redactProviderUrl(input.url)
  }
}

/** Query parameters that carry a credential, in the spellings these APIs use. */
const SECRET_QUERY_PARAMS = ['apikey', 'api_key', 'key', 'authkey', 'auth_key', 'token', 'access_token', 'secret', 'password', 'signature']

/**
 * Removes credentials from a URL so it can be logged.
 *
 * Falls back to dropping the whole query string when the URL cannot be parsed:
 * losing the parameters is a small cost, leaking a key is not.
 */
export function redactProviderUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const name of SECRET_QUERY_PARAMS) {
      if (parsed.searchParams.has(name)) parsed.searchParams.set(name, 'REDACTED')
    }
    return parsed.toString()
  } catch {
    const [path] = url.split('?')
    return path ? `${path}?REDACTED` : 'REDACTED'
  }
}

export interface GetJsonOptions {
  /** Adapter name, used in the error message so the logs say which provider failed. */
  provider: string
  url: string
  headers?: Record<string, string>
  /** Default 5s: long enough for a healthy provider, short enough that a page render survives one. */
  timeoutMs?: number
}

/**
 * Fetches JSON with a deadline. Throws `ProviderRequestError` for every failure
 * mode; never returns a partial or guessed value.
 *
 * `cache: 'no-store'` is deliberate. Every adapter has its own TTL cache, and
 * letting Next.js cache these responses as well would hide how often the
 * provider is really being called — and the callers here care about the
 * provider's own request budget.
 */
export async function getJson<T>(options: GetJsonOptions): Promise<T> {
  const { provider, url, headers, timeoutMs = 5_000 } = options

  let response: Response
  try {
    response = await fetch(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const kind: ProviderFailureKind =
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
    throw new ProviderRequestError({ kind, provider, url, detail: name || 'request failed' })
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderRequestError({ kind: 'auth', provider, url, status: response.status })
  }
  if (response.status === 429) {
    throw new ProviderRequestError({ kind: 'rate-limit', provider, url, status: 429 })
  }
  if (!response.ok) {
    throw new ProviderRequestError({ kind: 'http', provider, url, status: response.status })
  }

  try {
    return (await response.json()) as T
  } catch {
    // Deliberately not including the body: one of these providers echoes the
    // submitted key back in the response, so bodies are never logged.
    throw new ProviderRequestError({ kind: 'malformed', provider, url, status: response.status })
  }
}

/**
 * True when the error is worth logging as a configuration problem rather than a
 * transient one. Used by the adapters to decide between `console.error` and a
 * quieter path, and by the smoke script to explain its verdict.
 */
export function isProviderAuthFailure(error: unknown): boolean {
  return error instanceof ProviderRequestError && (error.kind === 'auth' || error.kind === 'rate-limit')
}
