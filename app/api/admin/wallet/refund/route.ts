import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { describePaymentError } from '@/lib/payments/errors'
import { refundTransaction } from '@/lib/payments/service'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { adminRefundSchema } from '@/lib/validation/schemas'

/**
 * Admin-only reversal for Predik transactions. Two cases are refundable:
 *  - a completed deposit: debits the available balance back out
 *  - a pending withdrawal: unlocks the held funds and cancels the payout
 *
 * Every reversal now also produces a refund payment record (with the provider
 * reference), a ledger entry, one user notification and an audit entry, and a
 * transaction can never be refunded twice (full refunds only).
 */
export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.wallet.refund' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const { transactionId, reason } = adminRefundSchema.parse(await readJsonBody(request))
    const result = await refundTransaction({
      adminUserId: admin.id,
      transactionId,
      reason: reason || undefined,
    })

    // Idempotent replay: the refund already exists, so nothing was moved a second
    // time. Reporting 200 would let an admin (or a double-clicked button, or a
    // retried request) believe a NEW reversal just happened; 409 says the truth
    // and the wallet is deliberately left untouched.
    if (result.replayed) {
      return NextResponse.json(
        {
          ok: false,
          error: 'This transaction has already been refunded. No money was moved again.',
          transactionId: result.transactionId,
          status: result.status,
          amountPaise: result.amountPaise,
          wallet: result.wallet,
        },
        { status: 409 },
      )
    }

    return NextResponse.json({
      ok: true,
      transactionId: result.transactionId,
      status: result.status,
      amountPaise: result.amountPaise,
      wallet: result.wallet,
    })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid refund request' }, { status: 400 })
    }
    const mapped = describePaymentError(error)
    if (mapped) {
      // A second refund attempt collides on the unique `<reference>-REFUND`
      // transaction or on the refund intent's idempotency key.
      const message = error instanceof Error && error.message === 'NOT_REFUNDABLE'
        ? 'This transaction cannot be refunded (it may already have been refunded)'
        : mapped.error
      return NextResponse.json({ ok: false, error: message }, { status: mapped.status })
    }
    console.error('[payments] admin refund failed', error)
    return NextResponse.json({ ok: false, error: 'The refund could not be processed' }, { status: 500 })
  }
}
