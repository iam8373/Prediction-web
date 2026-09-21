import 'server-only'

/**
 * Cross-site request protection for state-changing routes.
 *
 * The authentication model is a `SameSite=Lax` session cookie (see
 * `lib/auth/session.ts`), which already prevents a cross-site POST from
 * carrying the session. This module adds the independent second check the
 * platform needs, WITHOUT replacing that model and without a token mechanism
 * that would break server-to-server callers:
 *
 *   - state-changing requests that present an `Origin` (or `Referer`) header
 *     must match the request's own host, or an explicitly configured trusted
 *     origin
 *   - requests with no origin information at all (curl, scripts, tests, and
 *     same-origin navigations that omit it) are allowed, because they cannot be
 *     forged by a third-party website through a browser
 *
 * Deployment note: a production deployment serves the cookie `SameSite=None`,
 * so it travels cross-site and the host the browser reports is a proxy host,
 * not the one the application sees. Those proxy hosts must therefore be named
 * explicitly in `TRUSTED_ORIGINS=https://app.example.com`, together with any
 * additional host the deployment is reachable on. Hosts the hosting platform
 * publishes for the running deployment are trusted automatically; nothing about
 * this set is derived from the request.
 */

/**
 * Origins the hosting platform publishes for the running deployment. These come
 * from the environment, never from the request, so a caller cannot influence
 * them.
 */
function platformOrigins(): string[] {
  return [
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
    process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : undefined,
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined,
  ].filter((value): value is string => Boolean(value?.trim()))
}

/** Operator-configured allowlist. */
export function configuredOrigins(): string[] {
  return (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function normalise(origin: string): string | null {
  try {
    const url = new URL(origin.includes('://') ? origin : `https://${origin}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.host.toLowerCase()
  } catch {
    return null
  }
}

/** Hosts allowed to make state-changing requests. */
export function trustedHosts(): Set<string> {
  const hosts = new Set<string>()
  for (const value of [...configuredOrigins(), ...platformOrigins()]) {
    const host = normalise(value)
    if (host) hosts.add(host)
  }
  return hosts
}

function normaliseHost(value: string | null | undefined): string | null {
  const host = value?.split(',')[0]?.trim().toLowerCase()
  return host ? host : null
}

/**
 * Hosts that count as "this site" for the cross-site check.
 *
 * Only the platform-terminated `Host` header is trusted outright (falling back
 * to the request URL). A client-supplied `X-Forwarded-Host` is NOT accepted as
 * identity on its own: honouring an arbitrary forwarded host would let a caller
 * choose which origin counts as same-site and walk straight through the CSRF
 * check (`Origin: https://evil.example.com` + `X-Forwarded-Host:
 * evil.example.com`). Forwarded hosts are honoured only when the operator or the
 * platform has already published them as trusted, which is exactly the case a
 * proxy deployment needs.
 */
export function selfHosts(request: Request): Set<string> {
  const hosts = new Set<string>()
  const primary = normaliseHost(request.headers.get('host')) ?? urlHost(request)
  if (primary) hosts.add(primary)
  const trusted = trustedHosts()
  for (const forwarded of forwardedHosts(request)) {
    if (trusted.has(forwarded)) hosts.add(forwarded)
  }
  return hosts
}

function urlHost(request: Request): string | null {
  try {
    return new URL(request.url).host.toLowerCase()
  } catch {
    return null
  }
}

function forwardedHosts(request: Request): string[] {
  const raw = request.headers.get('x-forwarded-host')
  if (!raw) return []
  return raw
    .split(',')
    .map((value) => normaliseHost(value))
    .filter((value): value is string => Boolean(value))
}

function originOf(request: Request): string | null {
  const origin = request.headers.get('origin')?.trim()
  if (origin && origin !== 'null') return origin
  const referer = request.headers.get('referer')?.trim()
  return referer || null
}

export interface OriginDecision {
  ok: boolean
  reason?: 'cross_origin' | 'unparsable_origin'
  origin?: string
}

/**
 * Pure decision function (also used by tests): does this request's origin match
 * the host it was sent to, or a trusted origin?
 */
export function decideRequestOrigin(input: {
  method: string
  origin: string | null
  /** Hosts that represent this site. See `selfHosts`. */
  hosts: Set<string>
  trusted: Set<string>
}): OriginDecision {
  const method = input.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { ok: true }
  if (!input.origin) return { ok: true }
  const originHost = normalise(input.origin)
  if (!originHost) return { ok: false, reason: 'unparsable_origin', origin: input.origin }
  if (input.hosts.has(originHost)) return { ok: true, origin: input.origin }
  if (input.trusted.has(originHost)) return { ok: true, origin: input.origin }
  return { ok: false, reason: 'cross_origin', origin: input.origin }
}

/** True when the request may perform a state change. */
export function isTrustedRequestOrigin(request: Request): OriginDecision {
  return decideRequestOrigin({
    method: request.method,
    origin: originOf(request),
    hosts: selfHosts(request),
    trusted: trustedHosts(),
  })
}

export class CrossOriginRequestError extends Error {
  readonly origin?: string
  constructor(decision: OriginDecision) {
    super('CSRF_ORIGIN_REJECTED')
    this.name = 'CrossOriginRequestError'
    this.origin = decision.origin
  }
}

/** Throws `CSRF_ORIGIN_REJECTED` when a state-changing request is cross-site. */
export function assertTrustedRequestOrigin(request: Request): void {
  const decision = isTrustedRequestOrigin(request)
  if (!decision.ok) throw new CrossOriginRequestError(decision)
}
