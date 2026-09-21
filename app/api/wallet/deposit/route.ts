import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { getCurrentUser } from '@/lib/auth/session'
import { describePaymentError } from '@/lib/payments/errors'
import { createDepositPayment } from '@/lib/payments/service'
import { guardRequest, readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { getRequestKey } from '@/lib/trading/transaction-guards'
import { depositSchema } from '@/lib/validation/schemas'

/**
 * Create a deposit payment.
 *
 * The wallet is credited only when a provider result is verified — opening the
 * payment page (or a redirect) never credits anything. In demo mode the
 * provider settles inside this request; in sandbox mode the payment returns
 * `pending` and completes on a signature-verified webhook.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to add funds' }, { status: 401 })

  try {
    // Server-side abuse protection + cross-site check, before any work happens.
    await guardRequest({ request, bucket: 'deposit', key: `user:${user.id}`, scope: 'wallet.deposit' })
    const input = depositSchema.parse(await readJsonBody(request))
    const requestKey = getRequestKey(request)
    const result = await createDepositPayment({
      userId: user.id,
      amountPaise: input.amountPaise,
      method: input.method,
      requestKey,
    })

    if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'expired') {
      return NextResponse.json(
        {
          ok: false,
          error: 'The payment provider declined this deposit',
          paymentId: result.paymentId,
          status: result.status,
        },
        { status: 402 },
      )
    }

    // `checkoutUrl` is the provider-hosted page the user finishes payment on.
    // It is NOT a confirmation: the wallet is credited only by a verified
    // provider event. `reviewRequired` means provider truth did not match this
    // payment and a human must look before any credit.
    return NextResponse.json({
      ok: true,
      paymentId: result.paymentId,
      status: result.status,
      transactionId: result.transactionId,
      providerReference: result.providerReference,
      wallet: result.wallet,
      settled: result.settledImmediately,
      requiresAction: result.requiresAction ?? false,
      checkoutUrl: result.checkoutUrl,
      // Present in the Orders flow: the client opens the provider's checkout for
      // this order. No secret is returned — only the provider-issued order id.
      providerOrderId: result.providerOrderId,
      reviewRequired: result.reviewRequired ?? false,
    })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid deposit' }, { status: 400 })
    }
    const mapped = describePaymentError(error)
    if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status })
    console.error('[payments] deposit failed', error)
    return NextResponse.json({ ok: false, error: 'We could not add funds. Try again.' }, { status: 500 })
  }
}
