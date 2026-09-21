import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { getCurrentUser } from '@/lib/auth/session'
import { describePaymentError } from '@/lib/payments/errors'
import { createWithdrawalPayment } from '@/lib/payments/service'
import { guardRequest, readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { getRequestKey } from '@/lib/trading/transaction-guards'
import { withdrawSchema } from '@/lib/validation/schemas'

/**
 * Request a withdrawal.
 *
 * Funds move from available to locked *before* the provider is contacted, so
 * the same money can never be queued for payout twice. The locked balance is
 * released automatically if the provider rejects or the payout fails.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to withdraw' }, { status: 401 })

  try {
    // Withdrawals are the highest-value abuse target: limit them per account
    // and refuse cross-site requests before funds are reserved.
    await guardRequest({ request, bucket: 'withdrawal', key: `user:${user.id}`, scope: 'wallet.withdraw' })
    const input = withdrawSchema.parse(await readJsonBody(request))
    const requestKey = getRequestKey(request)
    const result = await createWithdrawalPayment({
      userId: user.id,
      amountPaise: input.amountPaise,
      destination: input.destination,
      requestKey,
    })

    if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'expired') {
      return NextResponse.json(
        {
          ok: false,
          error: 'The payout could not be sent. Your funds have been released back to your wallet.',
          paymentId: result.paymentId,
          status: result.status,
        },
        { status: 402 },
      )
    }

    // A `reviewRequired` payout is INDETERMINATE: the provider may have accepted
    // it before the connection broke, so the funds stay reserved and the payment
    // stays pending until the status lookup or a webhook resolves it.
    return NextResponse.json({
      ok: true,
      paymentId: result.paymentId,
      status: result.status,
      transactionId: result.transactionId,
      providerReference: result.providerReference,
      wallet: result.wallet,
      settled: result.settledImmediately,
      requiresAction: result.requiresAction ?? false,
      reviewRequired: result.reviewRequired ?? false,
    })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid withdrawal' }, { status: 400 })
    }
    const mapped = describePaymentError(error)
    if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status })
    console.error('[payments] withdrawal failed', error)
    return NextResponse.json({ ok: false, error: 'The withdrawal could not be created. Try again.' }, { status: 500 })
  }
}
