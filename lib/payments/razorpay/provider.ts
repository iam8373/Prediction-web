import 'server-only'

import { randomUUID } from 'node:crypto'

import { PaymentProviderError, type PaymentProvider, type ProviderPaymentRecord, type WebhookVerification } from '@/lib/payments/contracts'
import type { PaymentsMode } from '@/lib/payments/mode'
import type { ProviderCredentials } from '@/lib/payments/provider-credentials'

import { createRazorpayClient, type RazorpayEntity } from './client'
import {
  INTERNAL_REFERENCE_NOTE_KEY,
  mapPaymentStatus,
  mapPayoutStatus,
  mapRefundStatus,
  orderEntityToRecord,
  paymentEntityToRecord,
  payoutEntityToRecord,
  refundEntityToRecord,
} from './mapping'
import { verifyRazorpayWebhook } from './webhook'

/**
 * Razorpay adapter: deposits through the Payments API (Order + optional hosted
 * payment link) and withdrawals through RazorpayX payouts.
 *
 * Provider-specific behaviour that matters for correctness:
 *  - an `authorized` payment is NOT credited; only `captured` settles a deposit
 *  - withdrawal outcomes are decided by payout webhooks/status lookups, never by
 *    the initial create call, so a queued payout never finalises a debit
 *  - a payout reversal ("money came back") is reported as a failure so the
 *    reservation is released; if it arrives after our payment already completed,
 *    the state machine refuses the transition and the record is flagged for
 *    controlled review instead of silently reverting a settled withdrawal
 *  - the internal payment id is written into the order `notes` and echoed back,
 *    which is what proves a provider record belongs to our transaction
 */

const RAZORPAY_LABEL = 'Razorpay'

function shortReceipt(internalPaymentId: string) {
  // Razorpay receipts are limited to 40 characters; the full internal id travels
  // in `notes` where it is used for verification.
  const compact = internalPaymentId.replace(/[^a-z0-9]/gi, '').slice(-32)
  return `pk_${compact}`
}

function internalIdFrom(idempotencyKey: string, explicit?: string) {
  if (explicit) return explicit
  const match = /^pay:(.+)$/.exec(idempotencyKey)
  return match ? match[1] : idempotencyKey
}

export class RazorpayPaymentProvider implements PaymentProvider {
  readonly id = 'razorpay'
  readonly label = RAZORPAY_LABEL
  readonly mode: PaymentsMode
  readonly currency = 'INR'
  readonly capabilities = {
    asyncSettlement: true,
    cancelWithdrawal: true,
    // Razorpay supports partial refunds, but the product model does not: an
    // admin reversal is always full, so this stays false (fail closed).
    partialRefunds: false,
    listPayments: true,
  }

  private readonly client: ReturnType<typeof createRazorpayClient>
  private readonly credentials: ProviderCredentials

  constructor(credentials: ProviderCredentials, mode: PaymentsMode) {
    this.credentials = credentials
    this.mode = mode
    this.client = createRazorpayClient({
      keyId: credentials.keyId,
      keySecret: credentials.keySecret,
      accountNumber: credentials.accountNumber,
      payoutMode: credentials.payoutMode,
      apiBase: credentials.apiBase,
      redactSecrets: credentials.webhookSecrets,
    })
  }

  /* ----------------------------- deposits ----------------------------- */

  async createDeposit(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    method?: 'upi' | 'netbanking' | 'demo'
    internalPaymentId?: string
  }): Promise<ProviderPaymentRecord> {
    const internalPaymentId = internalIdFrom(input.idempotencyKey, input.internalPaymentId)
    const order = await this.client.createOrder({
      amountPaise: input.amountPaise,
      currency: input.currency,
      receipt: shortReceipt(internalPaymentId),
      notes: { [INTERNAL_REFERENCE_NOTE_KEY]: internalPaymentId },
    })
    const record = orderEntityToRecord(order, input.idempotencyKey)
    if (!record) throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The provider did not return an order id')

    if (!this.credentials.usePaymentLinks) {
      return { ...record, internalPaymentId, accountId: this.credentials.merchantAccountId }
    }

    const link = await this.client.createPaymentLink({
      amountPaise: input.amountPaise,
      currency: input.currency,
      description: `Predik deposit ${internalPaymentId}`,
      referenceId: internalPaymentId,
      notes: { [INTERNAL_REFERENCE_NOTE_KEY]: internalPaymentId, order_id: record.id },
    })
    return {
      ...record,
      checkoutUrl: link.short_url,
      internalPaymentId,
      accountId: this.credentials.merchantAccountId,
    }
  }

  /* ---------------------------- withdrawals ---------------------------- */

  async createWithdrawal(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    destination: string
    destinationRef?: string
    internalPaymentId?: string
    providerIdempotencyKey?: string
  }): Promise<ProviderPaymentRecord> {
    const internalPaymentId = internalIdFrom(input.idempotencyKey, input.internalPaymentId)
    const fundAccountId = input.destinationRef ?? (input.destination.startsWith('fa_')
      ? input.destination
      : await this.resolveFundAccount(input.destination, internalPaymentId))

    const payout = await this.client.createPayout({
      fundAccountId,
      amountPaise: input.amountPaise,
      currency: input.currency,
      // RazorpayX requires a UUID here; the service stores one per payment so a
      // retry reuses it and cannot pay twice.
      idempotencyKey: input.providerIdempotencyKey ?? randomUUID(),
      referenceId: internalPaymentId,
      narration: 'Predik withdrawal',
      notes: { [INTERNAL_REFERENCE_NOTE_KEY]: internalPaymentId },
    })
    const record = payoutEntityToRecord(payout, input.idempotencyKey)
    if (!record) throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The provider did not return a payout id')
    return { ...record, internalPaymentId, destinationRef: fundAccountId }
  }

  async cancelWithdrawal(input: { paymentId: string; idempotencyKey: string; reason?: string }): Promise<ProviderPaymentRecord> {
    const payout = await this.client.cancelPayout(input.paymentId, input.idempotencyKey)
    const record = payoutEntityToRecord(payout, input.idempotencyKey)
    if (!record) throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The provider did not return the cancelled payout')
    return { ...record, status: 'cancelled' }
  }

  /** Creates (or reuses) a fund account for a UPI VPA so a payout can run. */
  private async resolveFundAccount(vpa: string, internalPaymentId: string): Promise<string> {
    const contact = await this.client.createContact({
      name: `Predik trader ${internalPaymentId.slice(-6)}`,
      referenceId: internalPaymentId,
    })
    if (!contact.id) throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The provider did not return a contact id')
    const fundAccount = await this.client.createFundAccount({ contactId: contact.id, vpa })
    if (!fundAccount.id) throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The provider did not return a fund account id')
    return fundAccount.id
  }

  /* ------------------------------ refunds ------------------------------ */

  async refundPayment(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    originalProviderPaymentId: string
    originalReference: string
    partial?: boolean
    internalPaymentId?: string
  }): Promise<ProviderPaymentRecord> {
    if (input.partial) {
      throw new PaymentProviderError('PROVIDER_UNSUPPORTED_OPERATION', 'Partial refunds are not enabled for this product')
    }
    const internalPaymentId = internalIdFrom(input.idempotencyKey, input.internalPaymentId)

    // Reversing a not-yet-settled payout is a cancellation, not a refund.
    if (input.originalProviderPaymentId.startsWith('pout_')) {
      const payout = await this.client.cancelPayout(input.originalProviderPaymentId, input.idempotencyKey)
      const record = payoutEntityToRecord(payout, input.idempotencyKey)
      if (!record) throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The provider did not return the cancelled payout')
      // The economic effect we asked for (stop the payout, return the money) did
      // succeed, so the refund flow treats this as a successful reversal.
      return { ...record, status: 'succeeded' }
    }

    const refund = await this.client.createRefund({
      paymentId: input.originalProviderPaymentId,
      amountPaise: input.amountPaise,
      receipt: shortReceipt(internalPaymentId),
      notes: { [INTERNAL_REFERENCE_NOTE_KEY]: internalPaymentId },
    })
    const record = refundEntityToRecord(refund, input.idempotencyKey)
    if (!record) throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The provider did not return a refund id')
    return { ...record, internalPaymentId }
  }

  /* ------------------------- status and lookups ------------------------ */

  private async fetchEntity(providerId: string): Promise<RazorpayEntity | null> {
    try {
      if (providerId.startsWith('pout_')) return await this.client.fetchPayout(providerId)
      if (providerId.startsWith('rfnd_')) return await this.client.fetchRefund(providerId)
      if (providerId.startsWith('order_')) return await this.client.fetchOrder(providerId)
      return await this.client.fetchPayment(providerId)
    } catch (error) {
      // A 404 from the provider means "we have no such record" (reconciliation
      // reports missing_provider_record); anything else propagates.
      if (error instanceof PaymentProviderError && error.code === 'PROVIDER_HTTP_404') return null
      throw error
    }
  }

  private toRecord(entity: RazorpayEntity, idempotencyKey: string) {
    if (entity.id?.startsWith('pout_')) return payoutEntityToRecord(entity, idempotencyKey)
    if (entity.id?.startsWith('rfnd_')) return refundEntityToRecord(entity, idempotencyKey)
    if (entity.id?.startsWith('order_')) return orderEntityToRecord(entity, idempotencyKey)
    return paymentEntityToRecord(entity, idempotencyKey)
  }

  async verifyPayment(paymentId: string): Promise<ProviderPaymentRecord> {
    const entity = await this.fetchEntity(paymentId)
    if (!entity) throw new PaymentProviderError('PROVIDER_PAYMENT_NOT_FOUND')
    const record = this.toRecord(entity, `fetch:${paymentId}`)
    if (!record) throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The provider record could not be interpreted')
    return { ...record, accountId: this.accountIdOf(entity) }
  }

  async fetchPayment(paymentId: string): Promise<ProviderPaymentRecord | null> {
    const entity = await this.fetchEntity(paymentId)
    if (!entity) return null
    const record = this.toRecord(entity, `fetch:${paymentId}`)
    return record ? { ...record, accountId: this.accountIdOf(entity) } : null
  }

  async getPaymentStatus(paymentId: string) {
    const entity = await this.fetchEntity(paymentId)
    if (!entity) throw new PaymentProviderError('PROVIDER_PAYMENT_NOT_FOUND')
    if (entity.id?.startsWith('pout_')) return mapPayoutStatus(entity.status)
    if (entity.id?.startsWith('rfnd_')) return mapRefundStatus(entity.status)
    if (entity.id?.startsWith('order_')) return entity.status === 'paid' ? 'succeeded' : 'created'
    return mapPaymentStatus(entity.status)
  }

  async getWithdrawalStatus(paymentId: string) {
    const entity = await this.client.fetchPayout(paymentId)
    return mapPayoutStatus(entity.status)
  }

  async listPayments(input: { since: number; limit: number }): Promise<ProviderPaymentRecord[]> {
    const fromSeconds = Math.floor(input.since / 1000)
    const toSeconds = Math.floor(Date.now() / 1000)
    const collection = await this.client.listPayments({
      fromSeconds,
      toSeconds,
      count: Math.min(Math.max(input.limit, 1), 100),
    })
    const items = Array.isArray(collection.items) ? collection.items : []
    return items
      .map((entity) => this.toRecord(entity, `list:${entity.id}`))
      .filter((record): record is ProviderPaymentRecord => Boolean(record))
  }

  private accountIdOf(entity: RazorpayEntity) {
    return this.credentials.merchantAccountId ?? (typeof entity.notes?.account_id === 'string' ? (entity.notes.account_id as string) : undefined)
  }

  /* ----------------------------- webhooks ------------------------------ */

  async verifyWebhook(input: {
    rawBody: string
    headers: Record<string, string>
    nowSeconds?: number
  }): Promise<WebhookVerification> {
    const result = verifyRazorpayWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      secrets: this.credentials.webhookSecrets,
    })
    if (!result.ok) {
      // An authentic delivery for an event type we do not act on keeps its event
      // type and id, so the caller records the delivery under the provider's own
      // event id (which is what makes later retries idempotent and the delivery
      // findable by an admin) instead of under a content fingerprint.
      return result.reason === 'unsupported_event'
        ? { ok: false, reason: 'unsupported_event', eventType: result.eventType, eventId: result.eventId }
        : { ok: false, reason: result.reason }
    }
    return { ok: true, event: result.event }
  }
}
