import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { ZodError } from 'zod'

import { db } from '@/lib/db'
import { paymentIntents } from '@/lib/db/schema'
import { getPaymentConfig } from '@/lib/payments/config'
import { describePaymentError } from '@/lib/payments/errors'
import { assertPaymentPosture } from '@/lib/payments/mode'
import { getSandboxProvider } from '@/lib/payments/provider'
import { handleProviderWebhook } from '@/lib/payments/webhook'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { sandboxSimulationSchema } from '@/lib/validation/schemas'

/**
 * Sandbox-only helper: asks the simulated provider to settle or fail a payment
 * and replays the result through the *real* webhook path, signature included.
 *
 * This exists because Step 1 must be verifiable without a live PSP. It refuses
 * to run in demo or live mode (see `getSandboxProvider`) and it cannot bypass
 * webhook verification — it simply builds a correctly signed delivery.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.payments.sandbox' })
  if (!guard.ok) return guard.response

  try {
    const input = sandboxSimulationSchema.parse(await readJsonBody(request))
    // A deployment that refuses balance movement must not be able to create a
    // simulated credit through this helper either.
    assertPaymentPosture(getPaymentConfig())
    const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, input.paymentId)).limit(1)
    if (!intent) return NextResponse.json({ ok: false, error: 'Payment not found' }, { status: 404 })
    if (intent.provider !== 'sandbox') {
      return NextResponse.json({ ok: false, error: 'Only sandbox payments can be simulated' }, { status: 409 })
    }
    if (!intent.providerPaymentId) {
      return NextResponse.json({ ok: false, error: 'This payment has no provider reference yet' }, { status: 409 })
    }

    const provider = getSandboxProvider()
    const delivery = provider.buildOutcomeWebhook({
      paymentId: intent.providerPaymentId,
      outcome: input.outcome,
    })
    const result = await handleProviderWebhook({
      providerId: 'sandbox',
      rawBody: delivery.rawBody,
      headers: delivery.headers,
    })
    return NextResponse.json({ ok: result.status < 400, webhook: result.body }, { status: result.status })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid simulation request' }, { status: 400 })
    }
    const mapped = describePaymentError(error)
    if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status })
    console.error('[payments] sandbox simulation failed', error)
    return NextResponse.json({ ok: false, error: 'The sandbox payment could not be simulated' }, { status: 500 })
  }
}
