import { NextResponse } from 'next/server'

import { listAuditEntries } from '@/lib/audit/log'
import { getAdminPayments, listRecentWebhookEvents } from '@/lib/data/server-api'
import { publicPaymentConfig } from '@/lib/payments/config'
import { countPaymentsAwaitingProvider } from '@/lib/payments/recheck'
import { listReconciliationFindings, listReconciliationRuns } from '@/lib/payments/reconciliation'
import { requireAdmin } from '@/lib/security/admin-guard'

/**
 * Admin payment visibility: transaction id, user, amount, payment type,
 * provider, provider reference, status, created/updated times, refund status
 * and reconciliation status — plus recent webhook deliveries and
 * reconciliation findings. No payment secrets are ever exposed here.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'accountRead', scope: 'admin.payments.list' })
  if (!guard.ok) return guard.response

  const params = new URL(request.url).searchParams
  const [payments, webhookEvents, runs, findings, auditTrail, awaitingProvider] = await Promise.all([
    getAdminPayments({
      query: params.get('query') ?? '',
      direction: params.get('direction') ?? '',
      status: params.get('status') ?? '',
      limit: 100,
    }),
    listRecentWebhookEvents(20),
    listReconciliationRuns(5),
    listReconciliationFindings({ limit: 25 }),
    // Financial admin actions (refunds, withdrawal resolution, retries,
    // reconciliation runs, flagged payments) with actor and reason.
    listAuditEntries({ limit: 25 }),
    countPaymentsAwaitingProvider(),
  ])

  return NextResponse.json({
    ok: true,
    payments,
    webhookEvents,
    reconciliation: { runs, findings },
    auditTrail: auditTrail.map((entry) => ({
      id: entry.id,
      actorRole: entry.actorRole,
      actorUserId: entry.actorUserId ?? undefined,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      summary: entry.summary,
      createdAt: entry.createdAt,
    })),
    awaitingProvider,
    summary: publicPaymentConfig(),
  })
}
