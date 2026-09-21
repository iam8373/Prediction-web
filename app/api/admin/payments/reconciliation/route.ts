import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { describePaymentError } from '@/lib/payments/errors'
import { listReconciliationFindings, listReconciliationRuns, runPaymentReconciliation } from '@/lib/payments/reconciliation'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { reconciliationRunSchema } from '@/lib/validation/schemas'

export async function GET(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'accountRead', scope: 'admin.payments.reconciliation.read' })
  if (!guard.ok) return guard.response

  const includeMatched = new URL(request.url).searchParams.get('includeMatched') === 'true'
  const [runs, findings] = await Promise.all([
    listReconciliationRuns(10),
    listReconciliationFindings({ includeMatched, limit: 100 }),
  ])
  return NextResponse.json({ ok: true, runs, findings })
}

/**
 * Runs a reconciliation pass against the provider. Mismatches are recorded for
 * controlled handling and never auto-corrected.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.payments.reconciliation.run' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const input = reconciliationRunSchema.parse(await readJsonBody(request, { emptyFallback: {} }))
    const run = await runPaymentReconciliation({
      providerId: input.provider,
      limit: input.limit,
      sinceDays: input.sinceDays,
      actorUserId: admin.id,
    })
    return NextResponse.json({ ok: true, run })
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid reconciliation request' }, { status: 400 })
    }
    const mapped = describePaymentError(error)
    if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status })
    console.error('[payments] reconciliation failed', error)
    return NextResponse.json({ ok: false, error: 'Reconciliation could not be completed' }, { status: 500 })
  }
}
