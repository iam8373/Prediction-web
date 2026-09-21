/**
 * Razorpay <-> internal mapping. ALL provider-specific vocabulary lives here and
 * in the sibling files of this folder; nothing outside `lib/payments/razorpay/`
 * (plus the registry and the credential resolver) knows about Razorpay.
 *
 * Pure module: no HTTP, no database, no environment — so the mapping is unit
 * tested directly, including the awkward cases (authorized-but-not-captured,
 * reversed payouts, out-of-order events).
 *
 * API facts encoded here (Razorpay docs):
 *  - payments:  created | authorized | captured | refunded | failed
 *  - payouts:   queued | pending | processing | processed | reversed | cancelled | failed
 *  - refunds:   pending | processed | failed
 *  - events:    payment.authorized, payment.captured, payment.failed, order.paid,
 *               refund.created, refund.processed, refund.failed,
 *               payout.queued|pending|initiated|processing|updated|processed|reversed|failed|cancelled
 */

import type { ProviderPaymentRecord, ProviderWebhookEvent } from '@/lib/payments/contracts'
import { normalizeProviderAmountToPaise, type DepositMethod } from '@/lib/payments/limits'
import type { PaymentDirection, ProviderStatus } from '@/lib/payments/state-machine'

/** Razorpay payment status -> internal provider status. */
export const PAYMENT_STATUS_MAP: Record<string, ProviderStatus> = {
  created: 'created',
  // Authorised money is NOT ours yet: it must be captured before the wallet can
  // be credited, so it stays pending.
  authorized: 'pending',
  captured: 'succeeded',
  refunded: 'refunded',
  failed: 'failed',
}

/** Razorpay payout status -> internal provider status. */
export const PAYOUT_STATUS_MAP: Record<string, ProviderStatus> = {
  queued: 'processing',
  pending: 'processing',
  initiated: 'processing',
  processing: 'processing',
  updated: 'processing',
  processed: 'succeeded',
  // A reversed payout means the money came back to the business account: the
  // withdrawal did not settle, so the reservation must be released.
  reversed: 'failed',
  cancelled: 'cancelled',
  failed: 'failed',
}

/** Razorpay refund status -> internal provider status. */
export const REFUND_STATUS_MAP: Record<string, ProviderStatus> = {
  pending: 'processing',
  processed: 'succeeded',
  failed: 'failed',
}

export interface EventMapping {
  direction: PaymentDirection
  status: ProviderStatus
}

/** Webhook event type -> direction + status. */
export const EVENT_MAP: Record<string, EventMapping> = {
  'payment.authorized': { direction: 'deposit', status: 'pending' },
  'payment.captured': { direction: 'deposit', status: 'succeeded' },
  'payment.failed': { direction: 'deposit', status: 'failed' },
  'order.paid': { direction: 'deposit', status: 'succeeded' },
  'refund.created': { direction: 'refund', status: 'processing' },
  'refund.processed': { direction: 'refund', status: 'succeeded' },
  'refund.failed': { direction: 'refund', status: 'failed' },
  'payout.queued': { direction: 'withdrawal', status: 'processing' },
  'payout.pending': { direction: 'withdrawal', status: 'processing' },
  'payout.initiated': { direction: 'withdrawal', status: 'processing' },
  'payout.processing': { direction: 'withdrawal', status: 'processing' },
  'payout.updated': { direction: 'withdrawal', status: 'processing' },
  'payout.processed': { direction: 'withdrawal', status: 'succeeded' },
  'payout.reversed': { direction: 'withdrawal', status: 'failed' },
  'payout.failed': { direction: 'withdrawal', status: 'failed' },
  'payout.cancelled': { direction: 'withdrawal', status: 'cancelled' },
}

export function mapPaymentStatus(status: string | undefined): ProviderStatus {
  return PAYMENT_STATUS_MAP[(status ?? '').toLowerCase()] ?? 'pending'
}

export function mapPayoutStatus(status: string | undefined): ProviderStatus {
  return PAYOUT_STATUS_MAP[(status ?? '').toLowerCase()] ?? 'processing'
}

export function mapRefundStatus(status: string | undefined): ProviderStatus {
  return REFUND_STATUS_MAP[(status ?? '').toLowerCase()] ?? 'processing'
}

export function mapEventType(eventType: string | undefined): EventMapping | null {
  return EVENT_MAP[(eventType ?? '').toLowerCase()] ?? null
}

export function mapPaymentMethod(method: string | undefined): DepositMethod | undefined {
  const normalized = (method ?? '').toLowerCase()
  if (normalized === 'upi') return 'upi'
  if (normalized === 'netbanking') return 'netbanking'
  if (!normalized) return undefined
  // card / wallet / other rails: recorded in the description only.
  return undefined
}

/** Internal payment id we wrote into the order receipt/notes, echoed back by Razorpay. */
export const INTERNAL_REFERENCE_NOTE_KEY = 'predik_payment_id'

interface RazorpayEntity {
  id?: string
  entity?: string
  status?: string
  amount?: number
  amount_paid?: number
  amount_captured?: number
  currency?: string
  receipt?: string | null
  order_id?: string | null
  payment_id?: string | null
  reference_id?: string | null
  utr?: string | null
  method?: string
  notes?: Record<string, unknown> | null
  created_at?: number
  error_code?: string | null
  error_description?: string | null
  status_details?: { description?: string | null; reason?: string | null } | null
}

function createdAt(seconds: number | undefined, fallback: number) {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : fallback
}

function internalPaymentIdOf(entity: RazorpayEntity): string | undefined {
  const fromNotes = entity.notes?.[INTERNAL_REFERENCE_NOTE_KEY]
  if (typeof fromNotes === 'string' && fromNotes) return fromNotes
  // Orders echo our `receipt`, which we set to the internal payment id.
  if (typeof entity.receipt === 'string' && entity.receipt.startsWith('pay_')) return entity.receipt
  return undefined
}

/** Amount reported by the provider, in integer paise. */
export function amountPaiseOf(entity: RazorpayEntity): number {
  const raw = entity.amount_paid ?? entity.amount_captured ?? entity.amount ?? 0
  return normalizeProviderAmountToPaise(typeof raw === 'number' ? raw : 0, 'paise')
}

function toRecord(input: {
  entity: RazorpayEntity
  direction: PaymentDirection
  status: ProviderStatus
  idempotencyKey: string
  now: number
}): ProviderPaymentRecord | null {
  const { entity } = input
  if (!entity?.id) return null
  const failureReason = entity.error_description
    ?? entity.status_details?.description
    ?? (input.status === 'failed' ? 'The provider reported this payment as failed' : undefined)
  return {
    id: entity.id,
    // Prefer the payment/payout/refund id; fall back to the order id at create time.
    reference: entity.id,
    direction: input.direction,
    status: input.status,
    amountPaise: amountPaiseOf(entity),
    currency: (entity.currency ?? 'INR').toUpperCase(),
    idempotencyKey: input.idempotencyKey,
    method: mapPaymentMethod(entity.method),
    createdAt: createdAt(entity.created_at, input.now),
    updatedAt: input.now,
    failureCode: entity.error_code ?? entity.status_details?.reason ?? undefined,
    failureReason,
    orderId: entity.order_id ?? (entity.entity === 'order' ? entity.id : undefined) ?? undefined,
    internalPaymentId: internalPaymentIdOf(entity),
  }
}

export function paymentEntityToRecord(entity: RazorpayEntity, idempotencyKey: string, now = Date.now()) {
  return toRecord({ entity, direction: 'deposit', status: mapPaymentStatus(entity.status), idempotencyKey, now })
}

export function orderEntityToRecord(entity: RazorpayEntity, idempotencyKey: string, now = Date.now()) {
  const status: ProviderStatus = entity.status === 'paid' ? 'succeeded' : 'created'
  return toRecord({
    entity: { ...entity, entity: 'order' },
    direction: 'deposit',
    status,
    idempotencyKey,
    now,
  })
}

export function payoutEntityToRecord(entity: RazorpayEntity, idempotencyKey: string, now = Date.now()) {
  return toRecord({ entity, direction: 'withdrawal', status: mapPayoutStatus(entity.status), idempotencyKey, now })
}

export function refundEntityToRecord(entity: RazorpayEntity, idempotencyKey: string, now = Date.now()) {
  return toRecord({ entity, direction: 'refund', status: mapRefundStatus(entity.status), idempotencyKey, now })
}

/** Parsed parts of a Razorpay webhook envelope. */
export interface RazorpayWebhookPayload {
  eventId: string | null
  eventType: string
  entityId?: string
  orderId?: string
  paymentId?: string
  payoutId?: string
  refundId?: string
  amountPaise: number
  currency: string
  occurredAt: number
  method?: string
  status: string
  internalPaymentId?: string
  failureCode?: string
  failureReason?: string
}

export function parseWebhookBody(rawBody: string): RazorpayWebhookPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const envelope = parsed as {
    event?: string
    created_at?: number
    payload?: Record<string, { entity?: RazorpayEntity } | undefined>
    account_id?: string
  }
  if (!envelope.event || typeof envelope.event !== 'string') return null

  const payment = envelope.payload?.payment?.entity
  const order = envelope.payload?.order?.entity
  const payout = envelope.payload?.payout?.entity
  const refund = envelope.payload?.refund?.entity
  const entity = payment ?? payout ?? refund ?? order
  if (!entity) return null

  return {
    eventId: null,
    eventType: envelope.event,
    entityId: entity.id,
    orderId: entity.order_id ?? order?.id ?? undefined,
    paymentId: payment?.id ?? (envelope.event.startsWith('payment.') ? entity.id : undefined),
    payoutId: payout?.id,
    refundId: refund?.id,
    amountPaise: amountPaiseOf(payment ?? payout ?? refund ?? order ?? {}),
    currency: (entity.currency ?? 'INR').toUpperCase(),
    occurredAt: createdAt(envelope.created_at, Date.now()),
    method: payment?.method,
    status: entity.status ?? '',
    internalPaymentId: internalPaymentIdOf(entity),
    failureCode: entity.error_code ?? entity.status_details?.reason ?? undefined,
    failureReason: entity.error_description ?? entity.status_details?.description ?? undefined,
  }
}

/** Turns a verified webhook body into the internal event the service applies. */
export function webhookEventOf(input: {
  payload: RazorpayWebhookPayload
  eventId: string
  fallbackOccurredAt?: number
}): ProviderWebhookEvent | null {
  const mapping = mapEventType(input.payload.eventType)
  if (!mapping) return null
  const paymentId = mapping.direction === 'withdrawal'
    ? input.payload.payoutId
    : mapping.direction === 'refund'
      ? input.payload.refundId
      : input.payload.paymentId ?? input.payload.orderId
  if (!paymentId) return null
  return {
    providerEventId: input.eventId,
    eventType: input.payload.eventType,
    direction: mapping.direction,
    paymentId,
    reference: paymentId,
    status: mapping.status,
    amountPaise: input.payload.amountPaise,
    currency: input.payload.currency,
    occurredAt: input.payload.occurredAt || (input.fallbackOccurredAt ?? Date.now()),
    orderId: input.payload.orderId,
    internalPaymentId: input.payload.internalPaymentId,
  }
}
