import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { PAYMENT_RETENTION_POLICY, purgeExpiredPaymentRecords } from '@/lib/payments/retention'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { retentionPurgeSchema } from '@/lib/validation/schemas'

/**
 * Payment record retention.
 *
 * Reports the policy and, when asked, purges expired operational records
 * (handled webhook deliveries, reconciliation history). Financial records —
 * payment intents, transactions and ledger entries — are never deleted here.
 * Defaults to a dry run and is audited when it actually deletes.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'accountRead', scope: 'admin.payments.retention.policy' })
  if (!guard.ok) return guard.response
  return NextResponse.json({ ok: true, policy: PAYMENT_RETENTION_POLICY })
}

export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.payments.retention.purge' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const input = retentionPurgeSchema.parse(await readJsonBody(request, { emptyFallback: {} }))
    const result = await purgeExpiredPaymentRecords({ actorUserId: admin.id, dryRun: input.dryRun })
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid retention request' }, { status: 400 })
    }
    console.error('[payments] retention purge failed', error)
    return NextResponse.json({ ok: false, error: 'The retention purge could not be completed' }, { status: 500 })
  }
}
