/**
 * URL safety helpers.
 *
 * Two distinct problems, one module:
 *
 *  1. OUTBOUND REDIRECTS to a provider-hosted page. The value is issued by the
 *     payment provider (not by the user), but it still must not be followed
 *     blindly: a compromised or misconfigured provider response, or a bad
 *     configuration pointing at a different host, would otherwise be able to
 *     send a signed-in user anywhere (`javascript:`, a phishing host, an
 *     internal address with credentials in the URL). Only `https` on an
 *     allowlisted provider host is followed.
 *  2. INTERNAL paths. Anything derived from user input before a redirect must be
 *     a same-site absolute path — never a scheme, a protocol-relative URL or a
 *     backslash trick.
 *
 * Pure module: no environment mutation, no database, directly unit testable.
 */

/** Hosts allowed to serve a hosted payment page. */
const DEFAULT_CHECKOUT_HOSTS = ['razorpay.com', 'rzp.io', 'razorpay.me']

function extraCheckoutHosts(): string[] {
  return (process.env.PAYMENTS_CHECKOUT_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
}

/**
 * True only for an https payment page on an allowlisted provider host, with no
 * embedded credentials and no fragment tricks.
 */
export function isAllowedCheckoutUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.local')) return false
  return hostAllowed(host, [...DEFAULT_CHECKOUT_HOSTS, ...extraCheckoutHosts()])
}

/**
 * The checkout URL to hand to a browser, or undefined when it is not a vetted
 * provider page. Applied at every point where a stored/returned checkout URL
 * leaves the server, so a compromised or misconfigured provider response can
 * never be turned into an open redirect or a `javascript:` navigation.
 */
export function safeCheckoutUrl(value: unknown): string | undefined {
  return isAllowedCheckoutUrl(value) ? (value as string) : undefined
}

/**
 * A same-site absolute path, or null. Rejects absolute URLs, protocol-relative
 * URLs, backslash variants and control characters.
 */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('/')) return null
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  // Backslashes are normalised to slashes by some browsers ahead of the host.
  if (trimmed.includes('\\')) return null
  return trimmed.length <= 512 ? trimmed : null
}

/** Same-site path for a redirect target, defaulting to a safe fallback. */
export function redirectPathFor(value: unknown, fallback = '/'): string {
  return safeInternalPath(value) ?? fallback
}

/** True when a host is a public, routable address rather than internal/private. */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().trim()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host === '[::1]' || host === '::1') return false
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number)
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a >= 224) return false
    return true
  }
  // IPv6 literals: only the global unicast range is acceptable.
  if (host.includes(':')) return /^\[?(2|3)/.test(host.replace(/^\[|\]$/g, '')) || host.startsWith('[2')
  return true
}
