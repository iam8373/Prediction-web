import 'server-only'

import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'

import { db, type DbClient } from '@/lib/db'
import { auditLogs } from '@/lib/db/schema'

/**
 * Audit trail for administrative financial actions.
 *
 * Entries live in the application database rather than a separate audit store,
 * so an entry and the change it describes can be written in one transaction.
 * Callers pass their transaction handle whenever that atomicity matters.
 *
 * Never pass secrets (API keys, webhook secrets, signing material) into
 * `metadata` — audit rows are readable by admins.
 */

export type AuditActorRole = 'admin' | 'system' | 'provider' | 'user'

export interface AuditEntry {
  actorRole: AuditActorRole
  actorUserId?: string
  action: string
  entityType: string
  entityId: string
  summary: string
  metadata?: Record<string, unknown>
}

export const AUDIT_ACTIONS = {
  refundIssued: 'payment.refund.issued',
  refundFailed: 'payment.refund.failed',
  withdrawalCompleted: 'payment.withdrawal.completed',
  withdrawalFailed: 'payment.withdrawal.failed',
  withdrawalCancelled: 'payment.withdrawal.cancelled',
  paymentRetried: 'payment.retry',
  manualStateChange: 'payment.state.manual_change',
  reconciliationRun: 'payment.reconciliation.run',
  webhookRejected: 'payment.webhook.rejected',
  webhookProcessed: 'payment.webhook.processed',
  /** Provider state that needs controlled manual review before any wallet move. */
  paymentFlagged: 'payment.review.flagged',
  /** Bounded status re-check of pending/processing payments. */
  paymentRecheck: 'payment.recheck.run',
  /** Retention purge of old payment event records. */
  retentionPurge: 'payment.retention.purge',
  /** Privileged market lifecycle changes. These move real money at settlement. */
  marketCreated: 'market.created',
  marketStatusChanged: 'market.status.changed',
  marketResolved: 'market.resolved',
  /** A market was withdrawn rather than decided: every open position refunded at cost. */
  marketRetired: 'market.retired',
  /** Payment-account (eligibility/KYC/jurisdiction) state written by an admin. */
  paymentAccountChanged: 'payment.account.changed',
} as const

export async function recordAudit(entry: AuditEntry, client: DbClient = db) {
  await client.insert(auditLogs).values({
    id: `audit_${randomUUID()}`,
    actorRole: entry.actorRole,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    summary: entry.summary,
    metadata: entry.metadata ?? null,
    createdAt: Date.now(),
  })
}

export async function listAuditEntries(input: { entityType?: string; entityId?: string; limit?: number } = {}) {
  const limit = input.limit ?? 50
  if (input.entityType && input.entityId) {
    return db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, input.entityType), eq(auditLogs.entityId, input.entityId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
  }
  return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit)
}
