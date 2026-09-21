import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { describePaymentError } from '@/lib/payments/errors'
import { recheckStuckPayments } from '@/lib/payments/recheck'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { paymentRecheckSchema } from '@/lib/validation/schemas'

/**
 * Bounded provider status re-check for payments stuck in pending/processing.
 *
 * Admin only: the server session decides authorization (never a hidden button).
 * The re-check never credits anything itself — it hands provider truth to the
 * same service path a webhook uses, and flags anything it cannot settle safely.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.payments.recheck' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const input = paymentRecheckSchema.parse(await readJsonBody(request, { emptyFallback: {} }))
    const summary = await recheckStuckPayments({
      actorUserId: admin.id,
      providerId: input.provider,
      limit: input.limit,
      force: input.force,
    })
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid re-check request' }, { status: 400 })
    }
    const mapped = describePaymentError(error)
    if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status })
    console.error('[payments] re-check failed', error)
    return NextResponse.json({ ok: false, error: 'The payment re-check could not be completed' }, { status: 500 })
  }
}
