import 'server-only'

import { NextResponse } from 'next/server'

import { getCurrentUser } from '@/lib/auth/session'
import { SECURITY_EVENTS } from '@/lib/security/events'
import { guardRequest, logDeniedRequest, securityErrorResponse } from '@/lib/security/guard'
import type { RateLimitBucket } from '@/lib/security/rate-limit'
import type { SessionUser } from '@/types'

/**
 * The single server-side gate for every privileged endpoint.
 *
 * Authorization is decided here, from the session row in PostgreSQL — never
 * from a client header, body field, query parameter, or the fact that the admin
 * UI happened to render. A caller that is not an admin receives 403; an
 * unauthenticated caller receives 401. Both are recorded as security events so
 * repeated probing is visible.
 *
 * Ordering mirrors the hardened pipeline: authenticate -> authorize -> origin
 * check -> rate limit -> business logic. The budget is charged only after the
 * caller is confirmed to be an admin, so an unauthorized flood cannot spend a
 * legitimate operator's allowance and cannot write rate-limit rows either.
 *
 * Usage:
 *
 *   const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.refund' })
 *   if (!guard.ok) return guard.response
 *   const admin = guard.admin
 */

export type AdminGuardInput = {
  /** Budget charged only after the caller is confirmed to be an admin. */
  bucket?: RateLimitBucket
  /** Label used in the security log. */
  scope: string
}

export type AdminGuardResult =
  | { ok: true; admin: SessionUser }
  | { ok: false; response: NextResponse }

export async function requireAdmin(request: Request, input: AdminGuardInput): Promise<AdminGuardResult> {
  const user = await getCurrentUser()
  const path = safePath(request)

  if (!user) {
    await logDeniedRequest({
      action: SECURITY_EVENTS.unauthenticated,
      path,
      reason: 'Unauthenticated request to a privileged endpoint',
      metadata: { scope: input.scope, method: request.method },
    })
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: 'Sign in with an admin account' }, { status: 401 }),
    }
  }

  if (!user.isAdmin) {
    await logDeniedRequest({
      action: SECURITY_EVENTS.authzDenied,
      userId: user.id,
      path,
      reason: 'Non-admin account attempted a privileged operation',
      metadata: { scope: input.scope, method: request.method },
    })
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 }),
    }
  }

  try {
    await guardRequest({ request, bucket: input.bucket, key: `user:${user.id}`, scope: input.scope })
  } catch (error) {
    const mapped = securityErrorResponse(error)
    if (mapped) return { ok: false, response: mapped }
    throw error
  }

  return { ok: true, admin: user }
}

/** Route path for logging, without ever echoing query values back. */
function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname.slice(0, 120)
  } catch {
    return '/api/admin'
  }
}
