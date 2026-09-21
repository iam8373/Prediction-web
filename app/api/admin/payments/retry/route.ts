import { NextResponse } from 'next/server'
import { z } from 'zod'

import { describePaymentError } from '@/lib/payments/errors'
import { retryPayment } from '@/lib/payments/service'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'

const retrySchema = z.object({ paymentId: z.string().trim().min(1).max(120) })

/**
 * Re-drive a stuck payment from currently known provider truth. Used for the
 * "provider succeeded but our settlement did not complete" case; every attempt
 * is audited and the underlying state machine still refuses invalid moves.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.payments.retry' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const input = retrySchema.parse(await readJsonBody(request))
    const result = await retryPayment({ adminUserId: admin.id, paymentId: input.paymentId })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: 'Invalid retry request' }, { status: 400 })
    }
    const mapped = describePaymentError(error)
    if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status })
    console.error('[payments] retry failed', error)
    return NextResponse.json({ ok: false, error: 'The payment could not be retried' }, { status: 500 })
  }
}
