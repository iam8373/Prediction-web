import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { describePaymentError } from '@/lib/payments/errors'
import { resolveWithdrawal } from '@/lib/payments/service'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { adminWithdrawalActionSchema } from '@/lib/validation/schemas'

/**
 * Administrative withdrawal control: complete, fail or cancel a payout that has
 * not settled. Every action releases or finalises the reservation through the
 * payment service and writes an audit entry.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.payments.withdrawals' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const input = adminWithdrawalActionSchema.parse(await readJsonBody(request))
    const result = await resolveWithdrawal({
      adminUserId: admin.id,
      paymentId: input.paymentId,
      action: input.action,
      reason: input.reason || undefined,
    })
    return NextResponse.json({ ok: true, status: result.status, wallet: result.wallet })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid withdrawal action' }, { status: 400 })
    }
    const mapped = describePaymentError(error)
    if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status })
    console.error('[payments] admin withdrawal action failed', error)
    return NextResponse.json({ ok: false, error: 'The withdrawal could not be updated' }, { status: 500 })
  }
}
