/**
 * The one and only payment-provider contract.
 *
 * Nothing else in the application talks to a payment gateway. A provider
 * reports what happened at the gateway; it never touches Predik balances. The
 * application payment service (`lib/payments/service.ts`) is the only layer
 * allowed to translate a verified provider result into a wallet + ledger
 * mutation.
 */

import type { DepositMethod } from '@/lib/payments/limits'
import type { PaymentsMode } from '@/lib/payments/mode'
import type { PaymentDirection, ProviderStatus } from '@/lib/payments/state-machine'

export interface ProviderPaymentRecord {
  /** Provider-side payment id (e.g. `pi_...`, `payout_...`). */
  id: string
  /** Provider-side human reference shown to support/users. */
  reference: string
  direction: PaymentDirection
  status: ProviderStatus
  /** Always integer paise. Normalized before it reaches the wallet. */
  amountPaise: number
  currency: string
  idempotencyKey: string
  method?: DepositMethod
  createdAt: number
  updatedAt: number
  failureCode?: string
  failureReason?: string
  /** Hosted checkout link for redirect-based providers. */
  checkoutUrl?: string
  /** Provider-side anchor entity (order id for deposits, payout/refund id otherwise). */
  orderId?: string
  /**
   * The internal payment id the provider echoed back (order receipt / notes).
   * Used to prove the provider record belongs to OUR transaction for THIS user.
   */
  internalPaymentId?: string
  /** Provider merchant/account id the record belongs to, when reported. */
  accountId?: string
  /** Destination the payout was sent to, when the provider reports it back. */
  destinationRef?: string
}

export interface ProviderWebhookEvent {
  /** Provider event id — the idempotency key for webhook processing. */
  providerEventId: string
  /** e.g. payment.succeeded, payout.failed, refund.succeeded */
  eventType: string
  direction: PaymentDirection
  /** Provider payment id the event refers to. */
  paymentId: string
  reference: string
  status: ProviderStatus
  amountPaise: number
  currency: string
  occurredAt: number
  /** Present when the provider reports the anchor entity it belongs to. */
  orderId?: string
  internalPaymentId?: string
  accountId?: string
}

export type WebhookVerification =
  | { ok: true; event: ProviderWebhookEvent }
  | {
    ok: false
    reason: 'secret_unavailable' | 'missing' | 'malformed' | 'stale_timestamp' | 'digest_mismatch' | 'unparsable'
  }
  /** Authentic delivery for an event type this build does not act on. */
  | { ok: false; reason: 'unsupported_event'; eventType?: string; eventId?: string }

export interface PaymentProviderCapabilities {
  /** Results arrive asynchronously through signed webhooks rather than in the call response. */
  asyncSettlement: boolean
  cancelWithdrawal: boolean
  /** Partial reversals. Unused: the data model only supports full refunds. */
  partialRefunds: boolean
  /** Provider can list its own records, enabling MISSING_INTERNAL_RECORD detection. */
  listPayments: boolean
}

export interface PaymentProvider {
  readonly id: string
  readonly label: string
  readonly mode: PaymentsMode
  readonly currency: string
  readonly capabilities: PaymentProviderCapabilities

  createDeposit(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    method?: DepositMethod
    /** Internal payment id, echoed by the provider so records can be associated. */
    internalPaymentId?: string
  }): Promise<ProviderPaymentRecord>

  createWithdrawal(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    destination: string
    /** Provider-side destination handle (fund account) reused across retries. */
    destinationRef?: string
    internalPaymentId?: string
    /**
     * Deterministic provider idempotency key (a UUID), generated once and stored
     * on the payment so retries reuse it instead of paying twice.
     */
    providerIdempotencyKey?: string
  }): Promise<ProviderPaymentRecord>

  cancelWithdrawal(input: {
    paymentId: string
    idempotencyKey: string
    reason?: string
  }): Promise<ProviderPaymentRecord>

  refundPayment(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    originalProviderPaymentId: string
    originalReference: string
    partial?: boolean
    internalPaymentId?: string
  }): Promise<ProviderPaymentRecord>

  getPaymentStatus(paymentId: string): Promise<ProviderStatus>
  getWithdrawalStatus(paymentId: string): Promise<ProviderStatus>
  /** Full record fetch — used to verify amounts/currency before settlement. */
  verifyPayment(paymentId: string): Promise<ProviderPaymentRecord>
  /** Non-throwing lookup used by reconciliation. */
  fetchPayment(paymentId: string): Promise<ProviderPaymentRecord | null>
  /** Optional provider record listing (reconciliation only). */
  listPayments?(input: { since: number; limit: number }): Promise<ProviderPaymentRecord[]>

  /** Verifies authenticity and returns the parsed event. Never trusts raw JSON. */
  verifyWebhook(input: {
    rawBody: string
    headers: Record<string, string>
    nowSeconds?: number
  }): Promise<WebhookVerification>
}

export class PaymentProviderError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'PaymentProviderError'
    this.code = code
  }
}

export interface SimulatedProviderOptions {
  id: string
  label: string
  mode: PaymentsMode
  /**
   * `instant` settles in the create call (demo), `async` stays pending until a
   * signed provider webhook arrives (sandbox).
   */
  settlement: 'instant' | 'async'
  webhookSecret?: string
  /** Deterministic failure hook so failure paths are testable without env changes. */
  failureTrigger?: (amountPaise: number) => boolean
}
