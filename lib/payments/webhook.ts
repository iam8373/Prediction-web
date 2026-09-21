import 'server-only'

import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db } from '@/lib/db'
import { ensurePaymentSchema } from '@/lib/db/payment-schema'
import { paymentWebhookEvents } from '@/lib/db/schema'
import { getProviderById } from '@/lib/payments/provider'
import { applyProviderEvent } from '@/lib/payments/service'
import { payloadFingerprint } from '@/lib/payments/signature'
import { isUniqueViolation } from '@/lib/trading/transaction-guards'

/**
 * Provider webhook core.
 *
 *   provider -> POST /api/payments/webhook -> read RAW body -> verify signature
 *   -> check provider event id -> check idempotency -> load internal payment
 *   -> validate expected state -> database transaction -> update payment state
 *   -> wallet/ledger mutation when appropriate -> record webhook event -> 200
 *
 * A payment page redirect is never treated as confirmation: only a
 * signature-verified provider event (or a direct provider API response) can
 * advance a payment.
 */

export interface WebhookHandlerResult {
  status: number
  body: Record<string, unknown>
}

/** Reject absurd payloads before doing any cryptographic work. */
export const MAX_WEBHOOK_BYTES = 64 * 1024

const REJECTION_MESSAGES: Record<string, string> = {
  secret_unavailable: 'Webhook verification is not configured for this provider',
  missing: 'Missing webhook signature',
  malformed: 'Malformed webhook signature',
  stale_timestamp: 'Webhook timestamp is outside the accepted window',
  digest_mismatch: 'Webhook signature could not be verified',
  unparsable: 'Webhook payload could not be parsed',
}

export async function handleProviderWebhook(input: {
  providerId: string | null
  rawBody: string
  headers: Record<string, string>
  nowSeconds?: number
}): Promise<WebhookHandlerResult> {
  await ensurePaymentSchema()
  const providerId = input.providerId?.trim().toLowerCase()
  if (!providerId) return { status: 400, body: { ok: false, error: 'Unknown payment provider' } }

  const provider = getProviderById(providerId)
  if (!provider) return { status: 404, body: { ok: false, error: 'Unknown payment provider' } }

  const fingerprint = payloadFingerprint(input.rawBody)
  const receivedAt = Date.now()

  let verification
  try {
    verification = await provider.verifyWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      nowSeconds: input.nowSeconds,
    })
  } catch {
    verification = { ok: false as const, reason: 'unparsable' as const }
  }

  // An authentic delivery for an event type this build does not act on. It is
  // recorded and ACKNOWLEDGED: answering 401 would make the provider treat a
  // perfectly valid event as an authentication failure and retry it forever.
  if (!verification.ok && verification.reason === 'unsupported_event') {
    await db
      .insert(paymentWebhookEvents)
      .values({
        id: `whk_${randomUUID()}`,
        provider: provider.id,
        providerEventId: verification.eventId ?? `unhandled:${fingerprint.slice(0, 32)}`,
        eventType: verification.eventType ?? 'unhandled',
        status: 'ignored',
        payloadFingerprint: fingerprint,
        error: 'UNSUPPORTED_EVENT',
        receivedAt,
        processedAt: receivedAt,
      })
      .onConflictDoNothing()
    return { status: 200, body: { ok: true, ignored: true, reason: 'UNSUPPORTED_EVENT', eventType: verification.eventType } }
  }

  if (!verification.ok) {
    // Record the rejected delivery for investigation. The fingerprint is
    // one-way and no payload or secret is ever stored or logged.
    await db
      .insert(paymentWebhookEvents)
      .values({
        id: `whk_${randomUUID()}`,
        provider: provider.id,
        providerEventId: `unverified:${fingerprint.slice(0, 32)}`,
        eventType: 'unverified',
        status: 'rejected',
        payloadFingerprint: fingerprint,
        error: verification.reason,
        receivedAt,
        processedAt: receivedAt,
      })
      .onConflictDoNothing()
    await recordAudit({
      actorRole: 'provider',
      action: AUDIT_ACTIONS.webhookRejected,
      entityType: 'paymentWebhook',
      entityId: `${provider.id}:${fingerprint.slice(0, 32)}`,
      summary: `Rejected an unverified ${provider.id} webhook delivery (${verification.reason})`,
      metadata: { reason: verification.reason },
    }).catch(() => undefined)
    const status = verification.reason === 'secret_unavailable' ? 503 : 401
    return { status, body: { ok: false, error: REJECTION_MESSAGES[verification.reason] ?? 'Webhook rejected' } }
  }

  const event = verification.event
  let eventRowId: string
  try {
    const [inserted] = await db
      .insert(paymentWebhookEvents)
      .values({
        id: `whk_${randomUUID()}`,
        provider: provider.id,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        status: 'received',
        providerPaymentId: event.paymentId,
        payloadFingerprint: fingerprint,
        receivedAt,
      })
      .returning({ id: paymentWebhookEvents.id })
    eventRowId = inserted.id
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const [existing] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(
        eq(paymentWebhookEvents.provider, provider.id),
        eq(paymentWebhookEvents.providerEventId, event.providerEventId),
      ))
      .limit(1)
    if (!existing) return { status: 500, body: { ok: false, error: 'The webhook event could not be recorded' } }
    if (existing.status !== 'failed' && existing.status !== 'received') {
      // Already handled once — return success without a second economic effect.
      return { status: 200, body: { ok: true, duplicate: true, eventId: existing.providerEventId } }
    }
    const [retried] = await db
      .update(paymentWebhookEvents)
      .set({ status: 'received', error: null, attempts: sql`${paymentWebhookEvents.attempts} + 1`, providerPaymentId: event.paymentId })
      .where(eq(paymentWebhookEvents.id, existing.id))
      .returning({ id: paymentWebhookEvents.id })
    eventRowId = retried?.id ?? existing.id
  }

  try {
    const result = await applyProviderEvent({ providerId: provider.id, event })
    if (!result.handled) {
      await db
        .update(paymentWebhookEvents)
        .set({ status: 'ignored', error: result.reason ?? 'NOT_APPLICABLE', paymentIntentId: result.paymentId ?? null, processedAt: Date.now() })
        .where(eq(paymentWebhookEvents.id, eventRowId))
      return { status: 200, body: { ok: true, ignored: true, reason: result.reason } }
    }
    await db
      .update(paymentWebhookEvents)
      .set({ status: 'processed', paymentIntentId: result.paymentId ?? null, processedAt: Date.now() })
      .where(eq(paymentWebhookEvents.id, eventRowId))
    // Audit trail for the financial event itself. The payment intent, webhook
    // event, transaction, ledger entry and notification rows are the primary
    // chain; this entry makes the provider -> wallet -> ledger path visible to
    // admins in one place. A failure to write it must never fail a delivery
    // whose economic effect already committed, so it is logged, not re-thrown.
    await recordAudit({
      actorRole: 'provider',
      action: AUDIT_ACTIONS.webhookProcessed,
      entityType: 'paymentIntent',
      entityId: result.paymentId ?? `${provider.id}:${event.providerEventId}`,
      summary: `Provider event ${event.eventType} applied (${event.providerEventId})`,
      metadata: {
        provider: provider.id,
        eventType: event.eventType,
        providerEventId: event.providerEventId,
        duplicate: Boolean(result.duplicate),
      },
    }).catch((error) => {
      console.warn(`[payments] could not write the audit entry for ${event.providerEventId}:`, error instanceof Error ? error.message : error)
    })
    return {
      status: 200,
      body: { ok: true, paymentId: result.paymentId, duplicate: Boolean(result.duplicate), eventId: event.providerEventId },
    }
  } catch (error) {
    // Non-2xx makes the provider retry; the event row keeps the failure so the
    // retry can be processed and nothing is silently half-applied.
    const message = (error instanceof Error ? error.message : 'PROCESSING_ERROR').slice(0, 500)
    await db
      .update(paymentWebhookEvents)
      .set({ status: 'failed', error: message, processedAt: Date.now() })
      .where(eq(paymentWebhookEvents.id, eventRowId))
    console.error(`[payments] webhook ${event.providerEventId} (${event.eventType}) failed: ${message}`)
    return { status: 500, body: { ok: false, error: 'Webhook processing failed' } }
  }
}
