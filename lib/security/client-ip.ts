import 'server-only'

/**
 * The client address behind the deployment's proxy.
 *
 * `X-Forwarded-For` is a chain, not a value: each proxy *appends* the address it
 * accepted the connection from. A caller that sends its own `X-Forwarded-For`
 * therefore ends up in front of the address the deployment's proxy appends, so
 * reading the first entry lets the caller choose its own identity — and with it
 * its own rate-limit bucket. Withdrawals, deposits and sign-in all key their
 * abuse budgets on this value, so that is the difference between "one client is
 * being throttled" and "the limit is defeated by prepending a random address".
 *
 * Only the last entry — written by the proxy closest to this process, which is
 * the one that saw the real connection — describes the client. Every hop before
 * it is caller-supplied.
 *
 * Assumption worth knowing: this is correct for a deployment reached through one
 * appending proxy, which is what the hosting platform provides. Behind an
 * additional proxy or CDN, the last entry is that outer proxy instead, and the
 * deployment should be configured to pass a single, trusted header.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean)
    const lastHop = hops[hops.length - 1]
    if (lastHop) return lastHop.slice(0, 64)
  }

  // No forwarding chain at all: the request reached this process directly, so
  // there is nothing trustworthy to identify it by. Reporting a constant is
  // deliberate — any header still present here was supplied by the caller, and
  // reading it would hand them the same choice described above.
  return 'unknown'
}
