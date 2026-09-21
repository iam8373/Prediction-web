import 'server-only'

import { and, eq, lt, ne, sql } from 'drizzle-orm'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db } from '@/lib/db'
import { ensurePaymentSchema } from '@/lib/db/payment-schema'
import {
  paymentReconciliationFindings,
  paymentReconciliationRuns,
  paymentWebhookEvents,
} from '@/lib/db/schema'

/**
 * Payment record retention.
 *
 * Financial records are NOT purged: `payment_intent`, `transaction` and
 * `ledger_entry` rows are the accounting trail and are kept indefinitely. What
 * ages out is the operational noise around them — raw webhook delivery records
 * (which can be large and are only useful for investigation) and reconciliation
 * history — plus resolution state on findings that have been reviewed.
 *
 * Webhook rows that were REJECTED are kept longer, because they are evidence of
 * unverified traffic and may need to be shown to an acquirer.
 *
 * Also note what is never stored in the first place, per the compliance
 * boundary: no card numbers, no bank credentials, no provider secrets. Only the
 * provider's own opaque ids and a one-way payload fingerprint.
 */

export const PAYMENT_RETENTION_POLICY = {
  /** Handled webhook deliveries (processed/ignored/failed) are kept this long. */
  webhookEventDays: 90,
  /** Rejected (unverified) deliveries are evidence: kept longer. */
  rejectedWebhookEventDays: 365,
  /** Reconciliation runs and findings older than this are removed. */
  reconciliationDays: 180,
  /** Findings that were resolved and are older than this are removed too. */
  resolvedFindingDays: 365,
} as const

export interface RetentionPurgeResult {
  dryRun: boolean
  webhookEvents: number
  rejectedWebhookEvents: number
  reconciliationRuns: number
  reconciliationFindings: number
  cutoff: {
    webhookEvents: number
    rejectedWebhookEvents: number
    reconciliation: number
  }
  policy: typeof PAYMENT_RETENTION_POLICY
}

/**
 * Deletes expired operational payment records. Runs as an explicit admin action
 * (and is audited); `dryRun` reports what would be removed without deleting.
 */
export async function purgeExpiredPaymentRecords(options: { actorUserId?: string; dryRun?: boolean } = {}): Promise<RetentionPurgeResult> {
  await ensurePaymentSchema()
  const dryRun = options.dryRun ?? false
  const now = Date.now()
  const day = 86_400_000
  const webhookCutoff = now - PAYMENT_RETENTION_POLICY.webhookEventDays * day
  const rejectedCutoff = now - PAYMENT_RETENTION_POLICY.rejectedWebhookEventDays * day
  const reconciliationCutoff = now - PAYMENT_RETENTION_POLICY.reconciliationDays * day
  const resolvedCutoff = now - PAYMENT_RETENTION_POLICY.resolvedFindingDays * day

  const count = async (query: Promise<{ count: number }[]>) => {
    const [row] = await query
    return row?.count ?? 0
  }

  const handledFilter = and(
    lt(paymentWebhookEvents.receivedAt, webhookCutoff),
    ne(paymentWebhookEvents.status, 'rejected'),
  )
  const rejectedFilter = and(
    lt(paymentWebhookEvents.receivedAt, rejectedCutoff),
    eq(paymentWebhookEvents.status, 'rejected'),
  )

  const handledCount = await count(
    db.select({ count: sql<number>`count(*)::int` }).from(paymentWebhookEvents).where(handledFilter),
  )
  const rejectedCount = await count(
    db.select({ count: sql<number>`count(*)::int` }).from(paymentWebhookEvents).where(rejectedFilter),
  )
  const runsCount = await count(
    db.select({ count: sql<number>`count(*)::int` }).from(paymentReconciliationRuns).where(lt(paymentReconciliationRuns.startedAt, reconciliationCutoff)),
  )
  const findingsCount = await count(
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentReconciliationFindings)
      .where(and(
        lt(paymentReconciliationFindings.createdAt, reconciliationCutoff),
        // Never delete an open mismatch: a human has not looked at it yet.
        ne(paymentReconciliationFindings.status, 'mismatch'),
        ne(paymentReconciliationFindings.status, 'status_mismatch'),
        ne(paymentReconciliationFindings.status, 'amount_mismatch'),
        ne(paymentReconciliationFindings.status, 'currency_mismatch'),
      )),
  )
  const resolvedFindingsCount = await count(
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentReconciliationFindings)
      .where(and(lt(paymentReconciliationFindings.resolvedAt, resolvedCutoff))),
  )

  const result: RetentionPurgeResult = {
    dryRun,
    webhookEvents: handledCount,
    rejectedWebhookEvents: rejectedCount,
    reconciliationRuns: runsCount,
    reconciliationFindings: findingsCount + resolvedFindingsCount,
    cutoff: {
      webhookEvents: webhookCutoff,
      rejectedWebhookEvents: rejectedCutoff,
      reconciliation: reconciliationCutoff,
    },
    policy: PAYMENT_RETENTION_POLICY,
  }

  if (dryRun) return result

  await db.transaction(async (tx) => {
    await tx.delete(paymentWebhookEvents).where(handledFilter)
    await tx.delete(paymentWebhookEvents).where(rejectedFilter)
    await tx.delete(paymentReconciliationFindings).where(and(
      lt(paymentReconciliationFindings.createdAt, reconciliationCutoff),
      ne(paymentReconciliationFindings.status, 'mismatch'),
      ne(paymentReconciliationFindings.status, 'status_mismatch'),
      ne(paymentReconciliationFindings.status, 'amount_mismatch'),
      ne(paymentReconciliationFindings.status, 'currency_mismatch'),
    ))
    await tx.delete(paymentReconciliationFindings).where(lt(paymentReconciliationFindings.resolvedAt, resolvedCutoff))
    await tx.delete(paymentReconciliationRuns).where(lt(paymentReconciliationRuns.startedAt, reconciliationCutoff))
  })

  await recordAudit({
    actorRole: options.actorUserId ? 'admin' : 'system',
    actorUserId: options.actorUserId,
    action: AUDIT_ACTIONS.retentionPurge,
    entityType: 'paymentRetention',
    entityId: String(now),
    summary: `Purged ${result.webhookEvents + result.rejectedWebhookEvents} webhook records and ${result.reconciliationFindings} reconciliation records older than the retention window`,
    metadata: {
      webhookEvents: result.webhookEvents,
      rejectedWebhookEvents: result.rejectedWebhookEvents,
      reconciliationRuns: result.reconciliationRuns,
      reconciliationFindings: result.reconciliationFindings,
    },
  })

  return result
}
