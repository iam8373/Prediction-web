/**
 * Simulated payment provider.
 *
 * One implementation covers both development modes so the architecture does not
 * grow two near-identical adapters:
 *
 *  - `demo`    — settles inside the create call. No money moves anywhere.
 *  - `sandbox` — behaves like a real PSP: the payment starts `pending` and only
 *                advances when a *signed* webhook is delivered to
 *                `POST /api/payments/webhook`.
 *
 * It keeps its own ledger in memory (that is the "provider side"), so it is for
 * development, sandbox testing and state-machine verification only. A real PSP
 * adapter implements the same interface with HTTP calls.
 *
 * Deterministic test hook: an amount whose last two paise digits are `99`
 * (e.g. ₹5.99) is rejected by the provider, which makes failure and release
 * paths reproducible without touching configuration.
 */

import { PaymentProviderError, type PaymentProvider, type ProviderPaymentRecord, type SimulatedProviderOptions, type WebhookVerification } from '@/lib/payments/contracts'
import type { PaymentDirection, ProviderStatus } from '@/lib/payments/state-machine'
import { buildSignatureHeader, payloadFingerprint, SIGNATURE_HEADER, verifyWebhookSignature } from '@/lib/payments/signature'

export function defaultFailureTrigger(amountPaise: number): boolean {
  return amountPaise % 100 === 99
}

function reference(prefix: string) {
  const stamp = Date.now().toString(36).toUpperCase()
  const noise = Math.floor(Math.random() * 1_679_616)
    .toString(36)
    .toUpperCase()
    .padStart(4, '0')
  return `${prefix}${stamp}${noise}`
}

const EVENT_TYPES: Record<PaymentDirection, Record<'succeeded' | 'failed', string>> = {
  deposit: { succeeded: 'payment.succeeded', failed: 'payment.failed' },
  withdrawal: { succeeded: 'payout.succeeded', failed: 'payout.failed' },
  refund: { succeeded: 'refund.succeeded', failed: 'refund.failed' },
}

const EVENT_STATUS: Record<string, ProviderStatus> = {
  'payment.succeeded': 'succeeded',
  'payment.failed': 'failed',
  'payment.expired': 'expired',
  'payment.processing': 'processing',
  'payout.succeeded': 'succeeded',
  'payout.failed': 'failed',
  'payout.cancelled': 'cancelled',
  'refund.succeeded': 'succeeded',
  'refund.failed': 'failed',
}

const DIRECTION_PREFIX: Record<string, PaymentDirection> = {
  payment: 'deposit',
  payout: 'withdrawal',
  refund: 'refund',
}

interface SimulatedWebhookPayload {
  id: string
  type: string
  created: number
  data: {
    payment_id: string
    reference: string
    status: ProviderStatus
    amount_paise: number
    currency: string
    /**
     * The internal payment this event belongs to, echoed back the way a real
     * PSP echoes our receipt/notes. Carrying it means the webhook path applies
     * the same association check in simulator sandbox mode as a live provider
     * adapter does — without it, a signed event naming a different internal
     * payment would not be caught until production.
     */
    internal_reference?: string
  }
}

export class SimulatedPaymentProvider implements PaymentProvider {
  readonly id: string
  readonly label: string
  readonly mode: SimulatedProviderOptions['mode']
  readonly currency = 'INR'
  readonly capabilities

  private readonly settlement: SimulatedProviderOptions['settlement']
  private readonly webhookSecret?: string
  private readonly failureTrigger: (amountPaise: number) => boolean
  private readonly records = new Map<string, ProviderPaymentRecord>()
  private readonly byIdempotencyKey = new Map<string, string>()

  constructor(options: SimulatedProviderOptions) {
    this.id = options.id
    this.label = options.label
    this.mode = options.mode
    this.settlement = options.settlement
    this.webhookSecret = options.webhookSecret
    this.failureTrigger = options.failureTrigger ?? defaultFailureTrigger
    this.capabilities = {
      asyncSettlement: options.settlement === 'async',
      cancelWithdrawal: true,
      partialRefunds: false,
      listPayments: true,
    }
  }

  /**
   * Signing/verification is impossible without a secret, so webhook operations
   * fail closed. Creating payments does not need the secret: in `demo` mode a
   * payment settles in the create call, and in `sandbox` mode the registry
   * refuses to select this provider unless the secret is configured.
   */
  private assertWebhookConfigured() {
    if (!this.webhookSecret) {
      throw new PaymentProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `${this.label} cannot verify webhooks because its signing secret is missing`,
      )
    }
  }

  private remember(record: ProviderPaymentRecord) {
    this.records.set(record.id, record)
    this.byIdempotencyKey.set(record.idempotencyKey, record.id)
    return record
  }

  private existing(idempotencyKey: string) {
    const id = this.byIdempotencyKey.get(idempotencyKey)
    if (!id) return null
    return this.records.get(id) ?? null
  }

  private createRecord(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    direction: PaymentDirection
    prefix: string
    method?: ProviderPaymentRecord['method']
    status?: ProviderStatus
    internalPaymentId?: string
  }): ProviderPaymentRecord {
    const replay = this.existing(input.idempotencyKey)
    if (replay) return replay
    if (input.amountPaise !== Math.trunc(input.amountPaise)) {
      throw new PaymentProviderError('PROVIDER_AMOUNT_INVALID', 'Provider amounts must be integer paise')
    }
    const failed = this.failureTrigger(input.amountPaise)
    const status: ProviderStatus = input.status ?? (failed
      ? 'failed'
      : this.settlement === 'instant'
        ? 'succeeded'
        : 'pending')
    const now = Date.now()
    return this.remember({
      id: reference(input.direction === 'withdrawal' ? 'po_' : 'pi_'),
      reference: reference(input.direction === 'deposit' ? 'DEP' : input.direction === 'withdrawal' ? 'WDL' : 'RFD'),
      direction: input.direction,
      status,
      amountPaise: input.amountPaise,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
      method: input.method,
      internalPaymentId: input.internalPaymentId,
      createdAt: now,
      updatedAt: now,
      failureCode: failed ? 'provider_test_failure' : undefined,
      failureReason: failed ? 'The simulated provider rejected this payment (test hook: amounts ending in .99)' : undefined,
    })
  }

  async createDeposit(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    method?: ProviderPaymentRecord['method']
    internalPaymentId?: string
  }) {
    return this.createRecord({ ...input, direction: 'deposit', prefix: 'DEP' })
  }

  async createWithdrawal(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    destination: string
    internalPaymentId?: string
  }) {
    return this.createRecord({
      amountPaise: input.amountPaise,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
      direction: 'withdrawal',
      prefix: 'WDL',
      internalPaymentId: input.internalPaymentId,
    })
  }

  async cancelWithdrawal(input: { paymentId: string; idempotencyKey: string; reason?: string }) {
    const record = this.records.get(input.paymentId)
    if (!record) throw new PaymentProviderError('PROVIDER_PAYMENT_NOT_FOUND')
    if (record.direction !== 'withdrawal') throw new PaymentProviderError('PROVIDER_UNSUPPORTED_OPERATION')
    if (record.status === 'succeeded') throw new PaymentProviderError('PROVIDER_PAYMENT_ALREADY_SETTLED')
    const updated: ProviderPaymentRecord = {
      ...record,
      status: 'cancelled',
      updatedAt: Date.now(),
      failureReason: input.reason,
    }
    return this.remember(updated)
  }

  async refundPayment(input: {
    amountPaise: number
    currency: string
    idempotencyKey: string
    originalProviderPaymentId: string
    originalReference: string
    partial?: boolean
    internalPaymentId?: string
  }) {
    if (input.partial) throw new PaymentProviderError('PROVIDER_UNSUPPORTED_OPERATION', 'Partial refunds are not supported')
    const original = this.records.get(input.originalProviderPaymentId)
    if (!original) throw new PaymentProviderError('PROVIDER_PAYMENT_NOT_FOUND', 'The original provider payment is unknown')
    return this.createRecord({
      amountPaise: input.amountPaise,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
      direction: 'refund',
      prefix: 'RFD',
      internalPaymentId: input.internalPaymentId ?? original.internalPaymentId,
    })
  }

  async verifyPayment(paymentId: string) {
    const record = this.records.get(paymentId)
    if (!record) throw new PaymentProviderError('PROVIDER_PAYMENT_NOT_FOUND')
    return record
  }

  async fetchPayment(paymentId: string) {
    return this.records.get(paymentId) ?? null
  }

  async listPayments(input: { since: number; limit: number }) {
    return [...this.records.values()]
      .filter((record) => record.createdAt >= input.since)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, input.limit)
  }

  async getPaymentStatus(paymentId: string) {
    return (await this.verifyPayment(paymentId)).status
  }

  async getWithdrawalStatus(paymentId: string) {
    const record = await this.verifyPayment(paymentId)
    if (record.direction !== 'withdrawal') throw new PaymentProviderError('PROVIDER_UNSUPPORTED_OPERATION')
    return record.status
  }

  /**
   * Dev/sandbox helper: flip a simulated payment to a terminal outcome and
   * return a *signed* webhook request. The caller still has to run it through
   * normal signature verification, so this cannot bypass webhook security.
   */
  buildOutcomeWebhook(input: {
    paymentId: string
    outcome: 'succeeded' | 'failed'
    timestampSeconds?: number
  }): { rawBody: string; headers: Record<string, string> } {
    this.assertWebhookConfigured()
    const record = this.records.get(input.paymentId)
    if (!record) throw new PaymentProviderError('PROVIDER_PAYMENT_NOT_FOUND')
    const status: ProviderStatus = input.outcome
    const updated = this.remember({ ...record, status, updatedAt: Date.now() })
    const payload: SimulatedWebhookPayload = {
      id: reference('evt_'),
      type: EVENT_TYPES[updated.direction][input.outcome],
      created: Math.floor(Date.now() / 1000),
      data: {
        payment_id: updated.id,
        reference: updated.reference,
        status,
        amount_paise: updated.amountPaise,
        currency: updated.currency,
        internal_reference: updated.internalPaymentId,
      },
    }
    const rawBody = JSON.stringify(payload)
    const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000)
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: buildSignatureHeader(this.webhookSecret as string, rawBody, timestamp),
      },
    }
  }

  async verifyWebhook(input: {
    rawBody: string
    headers: Record<string, string>
    nowSeconds?: number
  }): Promise<WebhookVerification> {
    const header = input.headers[SIGNATURE_HEADER] ?? input.headers['X-Predik-Signature']
    const verification = verifyWebhookSignature({
      header,
      secret: this.webhookSecret,
      body: input.rawBody,
      nowSeconds: input.nowSeconds,
    })
    if (!verification.ok) return { ok: false, reason: verification.reason }

    let payload: SimulatedWebhookPayload
    try {
      payload = JSON.parse(input.rawBody) as SimulatedWebhookPayload
    } catch {
      return { ok: false, reason: 'unparsable' }
    }
    const status = EVENT_STATUS[payload?.type]
    const direction = DIRECTION_PREFIX[String(payload?.type).split('.')[0]]
    const data = payload?.data
    if (!payload?.id || !status || !direction || !data?.payment_id || !Number.isInteger(data.amount_paise)) {
      return { ok: false, reason: 'unparsable' }
    }
    return {
      ok: true,
      event: {
        providerEventId: payload.id,
        eventType: payload.type,
        direction,
        paymentId: data.payment_id,
        reference: data.reference,
        status,
        amountPaise: data.amount_paise,
        currency: data.currency,
        // Echoed association: verification refuses an event that names a
        // different internal payment (see `assertProviderMatchesIntent`).
        internalPaymentId: typeof data.internal_reference === 'string' && data.internal_reference ? data.internal_reference : undefined,
        occurredAt: (payload.created ?? Math.floor(Date.now() / 1000)) * 1000,
      },
    }
  }
}

/** Non-reversible fingerprint of a raw webhook body, for audit rows. */
export function webhookFingerprint(rawBody: string) {
  return payloadFingerprint(rawBody)
}
