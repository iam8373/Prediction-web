import 'server-only'

/**
 * Admin privilege and OTP delivery configuration.
 *
 * Both used to be decided by hardcoded literals inside `lib/auth/session.ts`:
 *
 *   isAdmin: phone === '9876543210'      // anyone with that number became admin
 *   const code = '424242'                // every account accepted a known code
 *
 * Those are development conveniences. In production they were a privilege
 * escalation path and a shared-secret login, so they are now configuration, and
 * they FAIL CLOSED when production has no configuration. The demo behaviour is
 * preserved only in non-production.
 *
 * Configuration (environment only, never client-supplied):
 *   ADMIN_PHONES=9876543210,9123456780   admin allowlist, digits, comma separated
 *   OTP_FIXED_CODE=424242                test/demo code, only when explicitly set
 *   ALLOW_DEMO_OTP=true                  opt in to the built-in demo code
 */

export function normalisePhone(value: string): string {
  return value.replace(/\D/g, '')
}

/**
 * Canonical comparison form for a phone number.
 *
 * An operator writing `+91 98765 43210` in configuration and a sign-in of
 * `9876543210` describe the same person, so the country code is folded away
 * before comparison. Numbers are stored without it, which keeps the allowlist
 * forgiving without inventing matches.
 */
export function canonicalPhone(value: string | null | undefined): string {
  const digits = normalisePhone(value ?? '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  return digits
}

/** Phone numbers allowed to hold admin privilege, from configuration only. */
export function adminPhoneAllowlist(): string[] {
  return (process.env.ADMIN_PHONES ?? '')
    .split(',')
    .map((value) => canonicalPhone(value))
    .filter((value) => value.length >= 10)
}

/**
 * True when this phone number may be granted admin privilege.
 *
 * Production: strictly the `ADMIN_PHONES` allowlist. There is no implicit admin
 * number in production, so a deployment that has not configured one simply has
 * no admins — the safe direction.
 *
 * Development: the documented demo number still elevates, so local demos and the
 * existing seeded account keep working.
 */
export function isConfiguredAdminPhone(phone: string | null | undefined): boolean {
  const normalized = canonicalPhone(phone)
  if (!normalized) return false
  const allowlist = adminPhoneAllowlist()
  if (allowlist.length > 0) return allowlist.includes(normalized)
  if (process.env.NODE_ENV === 'production') return false
  return normalized === '9876543210'
}

/** Always-on demo code used in development. Never used in production. */
export const DEMO_OTP = '424242'

export type OtpMode = 'demo' | 'configured' | 'unavailable'

export interface OtpCodeDecision {
  mode: OtpMode
  /** Present only in demo/configured mode. */
  code?: string
  /** Whether the code may be echoed back to the client (demo convenience). */
  disclose?: boolean
}

/**
 * Decides which one-time code this deployment may issue.
 *
 * `unavailable` means sign-in is not configured for this environment. The caller
 * must refuse the request rather than invent a code: issuing a fixed, publicly
 * documented code in production is equivalent to having no authentication.
 */
export function resolveOtpCode(): OtpCodeDecision {
  const configured = (process.env.OTP_FIXED_CODE ?? '').trim()
  if (configured) {
    if (!/^\d{4,8}$/.test(configured)) return { mode: 'unavailable' }
    // An explicitly configured code is treated as a deployment secret: never echoed.
    return { mode: 'configured', code: configured, disclose: false }
  }

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_OTP !== 'true') {
    return { mode: 'unavailable' }
  }

  return { mode: 'demo', code: DEMO_OTP, disclose: process.env.NODE_ENV !== 'production' }
}

/**
 * How a one-time code reaches the person signing in.
 *
 * `sms` means this deployment dispatched the code as a message. No SMS provider
 * is integrated in this codebase, so nothing is dispatched today and the sign-in
 * screen must not claim otherwise: every code issued here is a *shared* one —
 * either shown on the development sign-in screen or held by the operator as
 * `OTP_FIXED_CODE`. This is the single place to change once a delivery provider
 * is wired up.
 */
export function otpDeliveryChannel(): 'sms' | 'shared-code' {
  return 'shared-code'
}
