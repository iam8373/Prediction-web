/**
 * Production response hardening.
 *
 * Existing headers are preserved. Added in Phase 10:
 *  - `poweredByHeader: false` — stop advertising the framework version
 *  - a Content-Security-Policy that matches what this app actually loads
 *
 * CSP notes (deliberate, documented exceptions):
 *  - `'unsafe-inline'` for scripts is required because the Next.js App Router
 *    injects inline bootstrap/hydration scripts into the HTML document. Removing
 *    it requires a nonce issued from middleware, which is a larger architectural
 *    change than this phase allows.
 *  - `'unsafe-eval'` is intentionally NOT allowed in production (it is only used
 *    by the dev server's HMR runtime).
 *  - `img-src ... https:` allows remote market emblem/avatar images; the app also
 *    renders data: and blob: URLs.
 *  - `frame-src` is limited to the payment provider's checkout hosts, and
 *    `frame-ancestors` is left unset so the platform's own preview framing keeps
 *    working exactly as the existing `X-Frame-Options` allowed.
 *  - The CSP is only sent in production. The dev server needs eval and
 *    websocket connections, and Predik's dev preview runs inside the platform's
 *    frame; shipping the production policy to dev would break both.
 */
const isProduction = process.env.NODE_ENV === 'production'

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Deliberately narrow. Every third-party API this app talks to (CricketData,
  // API-Football, YouTube, AuthKey) is called from the server, and all browser
  // requests are same-origin `/api/...`. `connect-src https:` would let any
  // script that ever got into the bundle read from an arbitrary host, so only
  // the payment provider's API is named explicitly.
  "connect-src 'self' https://api.razorpay.com",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  'upgrade-insecure-requests',
].join('; ')

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
  ...(isProduction ? [{ key: 'Content-Security-Policy', value: contentSecurityPolicy }] : []),
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Do not describe the server stack in every response.
  poweredByHeader: false,
  images: {
    unoptimized: true,
  },
  // Build-time only: page-data collection defaults to one worker per CPU, which
  // exceeds the memory cgroup of a small container. Four workers keep `next
  // build` inside a 2 GB limit without changing any runtime behaviour.
  experimental: {
    cpus: 4,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
