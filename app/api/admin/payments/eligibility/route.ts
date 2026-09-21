import { NextResponse } from 'next/server'

import { decidePaymentEligibility } from '@/lib/payments/eligibility'
import { getPaymentConfig } from '@/lib/payments/config'
import { setPaymentAccountState } from '@/lib/payments/eligibility'
import { recordAudit, AUDIT_ACTIONS } from '@/lib/audit/log'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'

/**
 * Server-side eligibility decision for a user.
 *
 * `ELIGIBLE` / `NOT_ELIGIBLE` / `REQUIRES_REVIEW` is computed on the server from
 * the payment account state, the requested mode and the live gate — never from a
 * client preference. Admins use it to see exactly why a payment was refused.
 *
 * With `?mode=live` the decision is made against real-money rules even while the
 * deployment runs in sandbox, so eligibility can be prepared before cutover.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'accountRead', scope: 'admin.payments.eligibility.read' })
  if (!guard.ok) return guard.response

  const params = new URL(request.url).searchParams
  const userId = params.get('userId')?.trim()
  if (!userId) return NextResponse.json({ ok: false, error: 'A user id is required' }, { status: 400 })

  const config = getPaymentConfig()
  const requestedMode = params.get('mode')?.trim().toLowerCase()
  const mode = requestedMode === 'live' || requestedMode === 'sandbox' || requestedMode === 'demo'
    ? requestedMode
    : config.effective
  const direction = params.get('direction')?.trim() === 'withdrawal' ? 'withdrawal' : 'deposit'

  // The decision is informational here: it reports the reason rather than throwing.
  const result = await decidePaymentEligibility({ userId, direction, mode, config })
  return NextResponse.json({
    ok: true,
    userId,
    direction,
    currentMode: config.effective,
    liveEnabled: config.liveEnabled,
    blockers: config.blockers,
    eligibility: result,
  })
}

/**
 * Records an eligibility decision made outside Predik (KYC provider approval,
 * jurisdiction review). The decision itself is always derived on the server —
 * this only stores the account state it is derived from, and is audited.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminAction', scope: 'admin.payments.eligibility.write' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  let body: Record<string, unknown>
  try {
    body = (await readJsonBody(request)) as Record<string, unknown>
  } catch (error) {
    const mapped = securityErrorResponse(error)
    if (mapped) return mapped
    return NextResponse.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
  }

  const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
  if (!userId) return NextResponse.json({ ok: false, error: 'A user id is required' }, { status: 400 })

  const status = typeof body.status === 'string' && ['active', 'restricted', 'blocked'].includes(body.status)
    ? (body.status as 'active' | 'restricted' | 'blocked')
    : undefined
  const kycStatus = typeof body.kycStatus === 'string' && ['unverified', 'pending', 'verified', 'rejected'].includes(body.kycStatus)
    ? (body.kycStatus as 'unverified' | 'pending' | 'verified' | 'rejected')
    : undefined
  const liveEligible = typeof body.liveEligible === 'boolean' ? body.liveEligible : undefined
  const jurisdiction = typeof body.jurisdiction === 'string' ? body.jurisdiction.trim().toUpperCase().slice(0, 8) : undefined
  const restrictedReason = typeof body.restrictedReason === 'string' ? body.restrictedReason.trim().slice(0, 160) : undefined

  if (!status && !kycStatus && liveEligible === undefined && !jurisdiction) {
    return NextResponse.json({ ok: false, error: 'Nothing to update' }, { status: 400 })
  }

  const account = await setPaymentAccountState({ userId, status, kycStatus, liveEligible, jurisdiction, restrictedReason })
  const config = getPaymentConfig()
  const eligibility = await decidePaymentEligibility({ userId, direction: 'withdrawal', mode: config.effective, config })

  await recordAudit({
    actorRole: 'admin',
    actorUserId: admin.id,
    action: AUDIT_ACTIONS.paymentAccountChanged,
    entityType: 'paymentAccount',
    entityId: userId,
    summary: `Payment account updated (${[status && `status=${status}`, kycStatus && `kyc=${kycStatus}`, liveEligible !== undefined && `liveEligible=${liveEligible}`, jurisdiction && `jurisdiction=${jurisdiction}`].filter(Boolean).join(', ')})`,
    metadata: { eligibility: eligibility.decision, code: eligibility.code },
  })

  return NextResponse.json({ ok: true, account, eligibility })
}
