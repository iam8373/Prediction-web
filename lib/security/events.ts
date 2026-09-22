import 'server-only'

import { recordAudit, type AuditActorRole } from '@/lib/audit/log'
import { clientIp } from '@/lib/security/client-ip'

/**
 * Security event log.
 *
 * Unauthorized access, CSRF rejections, rate-limit trips and authentication
 * failures are financial-adjacent events: they must be reviewable after the
 * fact, so they are written to the same `audit_log` table the payment actions
 * use (no second audit store) with an explicit outcome.
 *
 * Rules:
 *  - never throws: a logging failure must not change the HTTP outcome of the
 *    request that triggered it
 *  - never stores credentials, tokens, cookies or raw identifiers that are not
 *    already tied to a known account; IPs are truncated anonymised prefixes
 */

export const SECURITY_EVENTS = {
  rateLimited: 'security.rate_limit.exceeded',
  originRejected: 'security.csrf.origin_rejected',
  authzDenied: 'security.authz.denied',
  unauthenticated: 'security.auth.unauthenticated',
  otpFailed: 'security.otp.failed',
  otpThrottled: 'security.otp.throttled',
  /** Sign-in was refused because no OTP delivery is configured (production). */
  otpUnavailable: 'security.otp.unavailable',
  /** A sign-in code was generated but the SMS gateway refused or could not deliver it. */
  otpDeliveryFailed: 'security.otp.delivery_failed',
  uploadRejected: 'security.upload.rejected',
} as const

export type SecurityOutcome = 'allowed' | 'denied' | 'failed' | 'throttled'

export interface SecurityEventInput {
  action: (typeof SECURITY_EVENTS)[keyof typeof SECURITY_EVENTS]
  actorRole?: AuditActorRole
  actorUserId?: string
  entityType: string
  entityId: string
  summary: string
  outcome: SecurityOutcome
  /** Small, non-secret context (bucket names, counts, reasons). */
  metadata?: Record<string, unknown>
}

export async function logSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    await recordAudit({
      actorRole: input.actorRole ?? 'system',
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      summary: input.summary,
      metadata: { ...input.metadata, outcome: input.outcome },
    })
  } catch (error) {
    console.warn('[security] could not record security event', {
      action: input.action,
      reason: error instanceof Error ? error.message : 'unknown',
    })
  }
}

/**
 * Anonymised client reference for pre-authentication events (OTP failures,
 * floods). Keeps the first two octets of IPv4 / first two groups of IPv6 so a
 * pattern is still reviewable without storing the full address.
 *
 * The address comes from `clientIp` (the hop the deployment's proxy appended),
 * so a caller cannot choose which prefix shows up in the audit trail.
 */
export function anonymisedClientRef(request: Request): string {
  const ip = clientIp(request)
  if (ip === 'unknown') return 'unknown'
  if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}::/32`
  const parts = ip.split('.')
  if (parts.length !== 4) return 'unknown'
  return `${parts[0]}.${parts[1]}.0.0/16`
}
