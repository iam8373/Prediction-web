import 'server-only'

import { and, asc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db } from '@/lib/db'
import { ensurePaymentSchema } from '@/lib/db/payment-schema'
import { notifications, paymentIntents } from '@/lib/db/schema'
import { getPaymentConfig } from '@/lib/payments/config'
import {
  isRecheckDue,
  isRecheckExhausted,
  OPEN_PAYMENT_STATUSES,
  PROVIDER_FINAL_STATUSES,
  RECHECK_POLICY,
} from '@/lib/payments/recheck-policy'
import {
  applyProviderEvent,
  providerForPayment,
} from '@/lib/payments/service'
import type { PaymentDirection, PaymentStatus } from '@/lib/payments/state-machine'
import type { PaymentRecheckOutcome, PaymentRecheckSummary } from '@/types'

export { isRecheckDue, nextRecheckDelayMs, RECHECK_POLICY } from '@/lib/payments/recheck-policy'

/**
 * Bounded provider status re-check.
 *
 * A webhook can be lost, delayed or delivered out of order, so payments can sit
 * in `pending`/`processing` while the provider already knows the truth. This
 * service asks the provider directly — but only politely:
 *
 *  - only payments that are not final and carry a provider payment id
 *  - never more than `maxAttempts` times per payment
 *  - with an increasing backoff (`nextRecheckDelayMs`), so nothing is polled
 *    aggressively and provider rate limits are respected
 *  - a payment that is still unclear after the budget is exhausted is FLAGGED
 *    for controlled review instead of being retried forever
 *
 * It never credits anything itself: the provider's reported state is handed to
 * `applyProviderEvent`, so the same verification, state-transition and
 * idempotency rules as a webhook apply.
 */

export interface RecheckOptions {
  /** Admin performing the re-check, when triggered manually. */
  actorUserId?: string
  providerId?: string
  limit?: number
  /** Ignore the backoff (used by an explicit admin re-check). */
  force?: boolean
}

/**
 * Inspects payments that may be stuck and resolves them from provider truth.
 * Safe to run repeatedly: every path is idempotent.
 */
export async function recheckStuckPayments(options: RecheckOptions = {}): Promise<PaymentRecheckSummary> {
  await ensurePaymentSchema()
  const config = getPaymentConfig()
  const providerFilter = options.providerId?.trim().toLowerCase()
  const limit = Math.min(Math.max(options.limit ?? RECHECK_POLICY.batchSize, 1), 100)
  const now = Date.now()

  const candidates = await db
    .select()
    .from(paymentIntents)
    .where(and(
      inArray(paymentIntents.status, [...OPEN_PAYMENT_STATUSES]),
      isNotNull(paymentIntents.providerPaymentId),
      lt(paymentIntents.recheckAttempts, RECHECK_POLICY.maxAttempts),
      providerFilter ? eq(paymentIntents.provider, providerFilter) : undefined,
      // Never touch a payment the provider has not answered for yet.
      lt(paymentIntents.createdAt, now - RECHECK_POLICY.minAgeMs),
    ))
    .orderBy(asc(paymentIntents.updatedAt))
    .limit(limit * 4)

  const due = candidates
    .filter((intent) => options.force || isRecheckDue({
      attempts: intent.recheckAttempts + 1,
      lastTouchedAt: intent.lastRecheckedAt ?? intent.updatedAt,
      now,
    }))
    .slice(0, limit)

  const outcomes: PaymentRecheckOutcome[] = []

  for (const intent of due) {
    const provider = providerForPayment(intent)
    if (!provider || !intent.providerPaymentId) {
      outcomes.push({ paymentId: intent.id, outcome: 'skipped', reason: 'PROVIDER_UNAVAILABLE' })
      continue
    }

    let record = null
    try {
      record = await provider.fetchPayment(intent.providerPaymentId)
    } catch (error) {
      // Provider outage / timeout: leave the payment exactly as it is and try
      // again later. Nothing is written, so nothing can be half-applied.
      const reason = error instanceof Error ? error.message : 'PROVIDER_LOOKUP_FAILED'
      await bookAttempt({ paymentId: intent.id, attempts: intent.recheckAttempts + 1, now, code: 'RECHECK_LOOKUP_FAILED', reason })
      outcomes.push({ paymentId: intent.id, outcome: 'provider_unavailable', reason })
      continue
    }

    if (!record) {
      // The provider has no record at all. That is a finding, not a failure we
      // invent: flag it once the re-check budget is exhausted.
      const exhausted = isRecheckExhausted(intent.recheckAttempts + 1)
      if (exhausted) {
        await flagExhausted({
          paymentId: intent.id,
          userId: intent.userId,
          attempts: intent.recheckAttempts + 1,
          code: 'PROVIDER_RECORD_MISSING',
          reason: 'The provider has no record of this payment after repeated checks',
          now,
        })
        outcomes.push({ paymentId: intent.id, outcome: 'flagged', reason: 'PROVIDER_RECORD_MISSING' })
        continue
      }
      await bookAttempt({ paymentId: intent.id, attempts: intent.recheckAttempts + 1, now, code: null, reason: null })
      outcomes.push({ paymentId: intent.id, outcome: 'no_provider_record' })
      continue
    }

    try {
      const result = await applyProviderEvent({
        providerId: intent.provider,
        event: {
          // Deliberately distinct from a webhook event id: this is our own
          // status probe, and the service-level checks keep it idempotent.
          providerEventId: `recheck:${intent.id}:${record.status}:${now}`,
          eventType: `recheck.${intent.direction}.${record.status}`,
          direction: intent.direction as PaymentDirection,
          paymentId: record.id,
          reference: record.reference,
          status: record.status,
          amountPaise: record.amountPaise,
          currency: record.currency,
          occurredAt: now,
          orderId: record.orderId,
          internalPaymentId: record.internalPaymentId,
        },
      })

      await bookAttempt({
        paymentId: intent.id,
        attempts: intent.recheckAttempts + 1,
        now,
        code: null,
        reason: null,
        reconciliationStatus: result.handled ? 'matched' : 'not_checkable',
      })

      if (!result.handled) {
        outcomes.push({ paymentId: intent.id, outcome: 'ignored', reason: result.reason })
      } else if (record.status === 'succeeded') {
        // `duplicate` means the wallet was already credited for this payment.
        outcomes.push({ paymentId: intent.id, outcome: result.duplicate ? 'already_settled' : 'settled', reason: record.reference })
      } else if (isProviderFinalStatus(record.status)) {
        outcomes.push({ paymentId: intent.id, outcome: 'failed', reason: record.status })
      } else {
        outcomes.push({ paymentId: intent.id, outcome: 'still_pending', reason: record.status })
      }
    } catch (error) {
      // A mismatch (amount/currency/reference) or an invalid transition: this
      // payment must not move based on a guess. Flag it for controlled review.
      const code = error instanceof Error ? error.message : 'RECHECK_FAILED'
      await flagExhausted({
        paymentId: intent.id,
        userId: intent.userId,
        attempts: intent.recheckAttempts + 1,
        code,
        reason: 'Automatic re-check could not safely settle this payment',
        now,
      })
      outcomes.push({ paymentId: intent.id, outcome: 'flagged', reason: code })
    }
  }

  const summary: PaymentRecheckSummary = {
    provider: providerFilter ?? config.providerId,
    mode: config.effective,
    checked: due.length,
    settled: outcomes.filter((o) => o.outcome === 'settled').length,
    stillPending: outcomes.filter((o) => o.outcome === 'still_pending' || o.outcome === 'no_provider_record').length,
    flagged: outcomes.filter((o) => o.outcome === 'flagged').length,
    unavailable: outcomes.filter((o) => o.outcome === 'provider_unavailable').length,
    outcomes,
  }

  if (options.actorUserId) {
    await recordAudit({
      actorRole: 'admin',
      actorUserId: options.actorUserId,
      action: AUDIT_ACTIONS.paymentRecheck,
      entityType: 'paymentRecheck',
      entityId: `${summary.provider}:${now}`,
      summary: `Re-checked ${summary.checked} payments: ${summary.settled} settled, ${summary.stillPending} still pending, ${summary.flagged} flagged`,
      metadata: { ...summary, outcomes: summary.outcomes.length },
    })
  }

  return summary
}

function isProviderFinalStatus(status: string): boolean {
  return PROVIDER_FINAL_STATUSES.includes(status)
}

/** Records an attempt without changing the payment's economic state. */
async function bookAttempt(input: {
  paymentId: string
  attempts: number
  now: number
  code: string | null
  reason: string | null
  reconciliationStatus?: string
}) {
  await db
    .update(paymentIntents)
    .set({
      recheckAttempts: input.attempts,
      lastRecheckedAt: input.now,
      updatedAt: input.now,
      ...(input.code ? { failureCode: input.code, failureReason: input.reason } : {}),
      ...(input.reconciliationStatus ? { reconciliationStatus: input.reconciliationStatus } : {}),
    })
    .where(eq(paymentIntents.id, input.paymentId))
}

/**
 * Stops re-checking and hands the payment to a human. The payment keeps its
 * state — money is neither invented nor lost — and it appears in the admin
 * reconciliation view with the exact reason.
 */
async function flagExhausted(input: {
  paymentId: string
  userId: string
  attempts: number
  code: string
  reason: string
  now: number
}) {
  await db.transaction(async (tx) => {
    await tx
      .update(paymentIntents)
      .set({
        recheckAttempts: input.attempts,
        lastRecheckedAt: input.now,
        reconciliationStatus: 'mismatch',
        failureCode: input.code,
        failureReason: input.reason,
        updatedAt: input.now,
      })
      .where(eq(paymentIntents.id, input.paymentId))

    await tx
      .insert(notifications)
      .values({
        id: `notification_admin_payment_${input.paymentId}`,
        userId: input.userId,
        eventKey: `payment:recheck-exhausted:${input.paymentId}`,
        kind: 'account',
        title: 'Payment needs a manual check',
        description: 'We could not confirm this payment automatically. Our team is reviewing it.',
        href: '/wallet',
        createdAt: input.now,
      })
      .onConflictDoNothing()

    await recordAudit(
      {
        actorRole: 'system',
        action: AUDIT_ACTIONS.paymentFlagged,
        entityType: 'paymentIntent',
        entityId: input.paymentId,
        summary: `Payment flagged for review after ${input.attempts} re-checks (${input.code})`,
        metadata: { code: input.code, attempts: input.attempts },
      },
      tx,
    )
  })
}

/** Count of payments currently waiting on a provider answer (admin visibility). */
export async function countPaymentsAwaitingProvider() {
  await ensurePaymentSchema()
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(and(
      or(
        inArray(paymentIntents.status, ['created', 'pending', 'processing'] as PaymentStatus[]),
      ),
      isNotNull(paymentIntents.providerPaymentId),
    ))
  return row?.count ?? 0
}
