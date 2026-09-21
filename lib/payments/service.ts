import 'server-only'

import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db, type DbClient } from '@/lib/db'
import { ensurePaymentSchema } from '@/lib/db/payment-schema'
import { ledgerEntries, notifications, paymentIntents, transactions, wallets } from '@/lib/db/schema'
import { getPaymentConfig, type PaymentConfig } from '@/lib/payments/config'
import { assertPaymentEligibility } from '@/lib/payments/eligibility'
import {
  MAX_DEPOSIT_PAISE,
  MAX_WITHDRAWAL_PAISE,
  MIN_DEPOSIT_PAISE,
  MIN_WITHDRAWAL_PAISE,
  normalizeProviderAmountToPaise,
  SUPPORTED_CURRENCY,
  type DepositMethod,
} from '@/lib/payments/limits'
import {
  getPaymentProvider,
  getProviderById,
  PaymentProviderError,
  type PaymentProvider,
  type ProviderPaymentRecord,
  type ProviderWebhookEvent,
} from '@/lib/payments/provider'
import { assertPaymentPosture } from '@/lib/payments/mode'
import {
  assertPaymentTransition,
  describePaymentStatus,
  isSettledPaymentStatus,
  type PaymentDirection,
  type PaymentStatus,
} from '@/lib/payments/state-machine'
import { safeCheckoutUrl } from '@/lib/security/url-safety'
import { lockResource } from '@/lib/trading/transaction-guards'

/**
 * Application payment service.
 *
 * This is the ONLY place that translates a verified provider result into a
 * wallet + ledger mutation. Providers never touch Predik balances, and route
 * handlers never write payments directly.
 *
 * Ordering rules that keep the accounting safe:
 *  1. an intent row is committed before any provider call
 *  2. provider truth is recorded (status `verified`) before money moves
 *  3. the wallet/ledger mutation is a single database transaction guarded by a
 *     row lock, a state-transition assertion and unique references
 *  4. if step 3 fails after the provider succeeded, the payment stays in
 *     `verified` with reconciliation status `pending` — an explicit,
 *     recoverable state rather than a silent partial write
 */

export interface WalletSnapshot {
  availablePaise: number
  lockedPaise: number
  bonusPaise: number
}

export interface PaymentOperationResult {
  paymentId: string
  status: PaymentStatus
  transactionId?: string
  providerReference?: string
  wallet: WalletSnapshot
  settledImmediately: boolean
  requiresAction?: boolean
  /** Hosted checkout link the user must be sent to (provider-backed deposits). */
  checkoutUrl?: string
  /** Provider order id, for the Orders + Checkout.js flow when no link is used. */
  providerOrderId?: string
  /** Set when the provider state needs controlled manual review before crediting. */
  reviewRequired?: boolean
}

export interface ApplyProviderEventResult {
  handled: boolean
  reason?: string
  paymentId?: string
  duplicate?: boolean
}

interface PaymentIntentRowShape {
  id: string
  userId: string
  direction: string
  status: string
  mode: string
  provider: string
  providerPaymentId: string | null
  providerReference: string | null
  providerStatus: string | null
  providerOrderRef?: string | null
  providerDestinationRef?: string | null
  providerIdempotencyKey?: string | null
  checkoutUrl?: string | null
  currency: string
  amountPaise: number
  providerAmountPaise: number | null
  feePaise: number
  netPaise: number
  requestKey: string
  method?: string | null
  destination: string | null
  transactionId: string | null
  parentPaymentId: string | null
  refundStatus: string
}

function internalReference(prefix: string, seed: string) {
  return `${prefix}-${seed.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase()}`
}

async function readWallet(client: DbClient, userId: string): Promise<WalletSnapshot> {
  const [wallet] = await client
    .select({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1)
  if (!wallet) throw new Error('ACCOUNT_NOT_READY')
  return wallet
}

function notificationEventKey(kind: string, paymentId: string) {
  return `payment:${kind}:${paymentId}`
}

async function notify(
  client: DbClient,
  input: { userId: string; kind: string; paymentId: string; title: string; description: string; createdAt: number },
) {
  await client
    .insert(notifications)
    .values({
      id: `notification_${randomUUID()}`,
      userId: input.userId,
      eventKey: notificationEventKey(input.kind, input.paymentId),
      kind: 'account',
      title: input.title,
      description: input.description,
      href: '/wallet',
      createdAt: input.createdAt,
    })
    .onConflictDoNothing()
}

function providerRecordAmount(record: ProviderPaymentRecord): number {
  // The simulated adapters report paise; `normalizeProviderAmountToPaise` is the
  // single place a provider unit is translated into internal integer paise.
  return normalizeProviderAmountToPaise(record.amountPaise, 'paise')
}

/**
 * Provider-result verification. Nothing is credited until the provider record
 * matches the internal payment: amount, currency, our own payment reference and
 * (when reported) the merchant account.
 */
function assertProviderMatchesIntent(intent: PaymentIntentRowShape, record: ProviderPaymentRecord) {
  if (providerRecordAmount(record) !== intent.amountPaise) throw new Error('PAYMENT_AMOUNT_MISMATCH')
  if (record.currency !== intent.currency) throw new Error('PAYMENT_CURRENCY_MISMATCH')
  // Association: the provider echoes the internal payment id we sent it, so a
  // record for another user's or another order's payment can never settle this one.
  if (record.internalPaymentId && record.internalPaymentId !== intent.id) {
    throw new Error('PAYMENT_REFERENCE_MISMATCH')
  }
  if (record.orderId && intent.providerOrderRef && record.orderId !== intent.providerOrderRef) {
    throw new Error('PAYMENT_REFERENCE_MISMATCH')
  }
  const expectedAccount = getPaymentConfig().providerOptions.merchantAccountId
  if (record.accountId && expectedAccount && record.accountId !== expectedAccount) {
    throw new Error('PAYMENT_ACCOUNT_MISMATCH')
  }
}

/**
 * The refund equivalent of `assertProviderMatchesIntent`.
 *
 * A refund settlement moves money OUT of a user's balance, so the same proof is
 * required as for a deposit: the provider record must report exactly the amount
 * we asked to refund, in the currency of the internal payment, and (when it
 * echoes a reference) reference THIS refund. Without this a provider-side
 * partial refund, a different currency, or a refund record belonging to another
 * payment could debit a full internal amount, and the internal ledger would
 * disagree with the provider.
 */
function assertProviderMatchesRefund(refund: PaymentIntentRowShape, record: ProviderPaymentRecord) {
  if (providerRecordAmount(record) !== refund.amountPaise) throw new Error('PAYMENT_AMOUNT_MISMATCH')
  if (record.currency !== refund.currency) throw new Error('PAYMENT_CURRENCY_MISMATCH')
  if (record.internalPaymentId && record.internalPaymentId !== refund.id) {
    throw new Error('PAYMENT_REFERENCE_MISMATCH')
  }
}

/** Errors that leave the internal payment healthy and reviewers in charge. */
const REVIEW_CODES = new Set([
  'PAYMENT_AMOUNT_MISMATCH',
  'PAYMENT_CURRENCY_MISMATCH',
  'PAYMENT_REFERENCE_MISMATCH',
  'PAYMENT_ACCOUNT_MISMATCH',
  'REFUND_REVIEW_REQUIRED',
])

function isReviewRequired(error: unknown): boolean {
  return error instanceof Error && REVIEW_CODES.has(error.message)
}

/**
 * A provider request that timed out or hit an outage is INDETERMINATE: the
 * payment may exist at the provider. We never fail such a payment (that would
 * be a false negative) and never settle it (that would be a false positive) — it
 * stays pending with reconciliation status `pending` until the status lookup or
 * a webhook resolves the truth.
 */
function isIndeterminateProviderFailure(error: unknown): boolean {
  if (!(error instanceof PaymentProviderError)) return false
  if (error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_BAD_RESPONSE') {
    return true
  }
  return /^PROVIDER_HTTP_5\d\d$/.test(error.code)
}

function failureOf(error: unknown): { code: string; reason: string } {
  if (error instanceof PaymentProviderError) return { code: error.code, reason: error.message }
  const message = error instanceof Error ? error.message : 'PAYMENT_PROVIDER_ERROR'
  return { code: 'PAYMENT_PROVIDER_ERROR', reason: message }
}

/**
 * Marks a payment for controlled review instead of guessing. The payment keeps
 * its state (so the money is neither lost nor invented) and appears in the admin
 * reconciliation view with the exact reason.
 */
async function flagForReview(input: { paymentId: string; code: string; reason: string; actorUserId?: string }) {
  await db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.paymentId)
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.paymentId))
      .for('update')
      .limit(1)
    if (!intent) return
    const now = Date.now()
    await tx
      .update(paymentIntents)
      .set({ reconciliationStatus: 'mismatch', failureCode: input.code, failureReason: input.reason, updatedAt: now })
      .where(eq(paymentIntents.id, intent.id))
    await recordAudit(
      {
        actorRole: input.actorUserId ? 'admin' : 'system',
        actorUserId: input.actorUserId,
        action: AUDIT_ACTIONS.paymentFlagged,
        entityType: 'paymentIntent',
        entityId: intent.id,
        summary: `Payment flagged for review (${input.code}): ${input.reason}`,
        metadata: { code: input.code, status: intent.status, provider: intent.provider },
      },
      tx,
    )
  })
}

/* ------------------------------------------------------------------ *
 * Deposit
 * ------------------------------------------------------------------ */

/**
 * A replayed idempotency key must describe the SAME operation.
 *
 * The unique `(user_id, request_key)` index makes a retried request return the
 * stored payment — that is what idempotency is for. It must not become a way to
 * mutate an existing payment: a retry carrying a different amount would reach
 * the provider with the new amount while the recorded intent still held the old
 * one. Verification does catch that mismatch later (so no money moves), but the
 * request should never be accepted in the first place.
 */
function assertIdempotentReplay(
  intent: PaymentIntentRowShape,
  expected: { direction: PaymentDirection; amountPaise: number; method?: string | null; destination?: string | null },
): void {
  const sameDirection = intent.direction === expected.direction
  const sameAmount = intent.amountPaise === expected.amountPaise
  const sameMethod = expected.method === undefined || (intent.method ?? 'demo') === (expected.method ?? 'demo')
  const sameDestination = expected.destination === undefined || (intent.destination ?? '') === (expected.destination ?? '')
  if (!sameDirection || !sameAmount || !sameMethod || !sameDestination) {
    throw new Error('IDEMPOTENCY_KEY_REUSED')
  }
}

export async function createDepositPayment(input: {
  userId: string
  amountPaise: number
  method?: DepositMethod
  requestKey: string
}): Promise<PaymentOperationResult> {
  await ensurePaymentSchema()
  const config = getPaymentConfig()
  // Refuses new monetary exposure on a deployment that cannot honour its
  // configured payment mode (PAYMENTS_CONFIG_DEGRADED) or has not satisfied the
  // live gate (PAYMENTS_LIVE_DISABLED) — checked before anything is written.
  assertPaymentPosture(config)
  assertDepositAmount(input.amountPaise, config)
  await assertPaymentEligibility({ userId: input.userId, direction: 'deposit', mode: config.effective, config })
  const provider = getPaymentProvider()

  // Step 1 — commit the intent before talking to the provider. The unique
  // (userId, requestKey) index makes a retried request return the same payment.
  const prepared = await db.transaction(async (tx) => {
    await lockResource(tx, 'payment-idempotency', input.userId, input.requestKey)
    const [existing] = await tx
      .select()
      .from(paymentIntents)
      .where(and(eq(paymentIntents.userId, input.userId), eq(paymentIntents.requestKey, input.requestKey)))
      .limit(1)
    if (existing) return { replayed: true, intent: existing as PaymentIntentRowShape }

    const now = Date.now()
    const [created] = await tx
      .insert(paymentIntents)
      .values({
        id: `pay_${randomUUID()}`,
        userId: input.userId,
        direction: 'deposit',
        status: 'created',
        mode: config.effective,
        provider: provider.id,
        currency: SUPPORTED_CURRENCY,
        amountPaise: input.amountPaise,
        feePaise: 0,
        netPaise: input.amountPaise,
        method: input.method ?? 'demo',
        requestKey: input.requestKey,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    return { replayed: false, intent: created as PaymentIntentRowShape }
  })

  const intent = prepared.intent
  if (prepared.replayed) {
    assertIdempotentReplay(intent, {
      direction: 'deposit',
      amountPaise: input.amountPaise,
      method: input.method ?? 'demo',
    })
  }
  if (prepared.replayed && intent.status !== 'created') {
    // Never call the provider twice for the same request.
    return {
      paymentId: intent.id,
      status: intent.status as PaymentStatus,
      transactionId: intent.transactionId ?? undefined,
      providerReference: intent.providerReference ?? undefined,
      wallet: await readWallet(db, input.userId),
      settledImmediately: intent.status === 'completed',
      requiresAction: intent.status === 'pending' || intent.status === 'processing',
      // Re-validated on the way out: the browser must never be pointed at an
      // address that is not a vetted provider checkout page.
      checkoutUrl: safeCheckoutUrl(intent.checkoutUrl),
      providerOrderId: intent.providerOrderRef ?? undefined,
    }
  }

  let record: ProviderPaymentRecord
  try {
    record = await provider.createDeposit({
      amountPaise: input.amountPaise,
      currency: SUPPORTED_CURRENCY,
      idempotencyKey: `pay:${intent.id}`,
      method: input.method,
      internalPaymentId: intent.id,
    })
  } catch (error) {
    const failure = failureOf(error)
    if (isIndeterminateProviderFailure(error)) {
      // The provider may have created a payment before the connection broke. The
      // payment stays pending (no credit, no failure) and the bounded re-check or
      // a webhook settles the truth.
      await markIndeterminate({ paymentId: intent.id, code: failure.code, reason: failure.reason })
      return {
        paymentId: intent.id,
        status: 'pending',
        wallet: await readWallet(db, input.userId),
        settledImmediately: false,
        reviewRequired: true,
      }
    }
    await failPayment({ paymentId: intent.id, status: 'failed', code: failure.code, reason: failure.reason })
    return {
      paymentId: intent.id,
      status: 'failed',
      wallet: await readWallet(db, input.userId),
      settledImmediately: false,
    }
  }

  await recordProviderAccepted({ intent, record })

  if (record.status === 'failed' || record.status === 'cancelled' || record.status === 'expired') {
    await failPayment({
      paymentId: intent.id,
      status: record.status === 'expired' ? 'expired' : record.status === 'cancelled' ? 'cancelled' : 'failed',
      code: record.failureCode ?? `PROVIDER_${record.status.toUpperCase()}`,
      reason: record.failureReason ?? 'The provider declined this payment',
    })
    return {
      paymentId: intent.id,
      status: record.status === 'expired' ? 'expired' : 'failed',
      providerReference: record.reference,
      wallet: await readWallet(db, input.userId),
      settledImmediately: false,
    }
  }

  if (record.status === 'succeeded') {
    try {
      const settlement = await markVerifiedAndSettleDeposit({ intentId: intent.id, record })
      return {
        paymentId: intent.id,
        status: settlement.status,
        transactionId: settlement.transactionId,
        providerReference: record.reference,
        wallet: settlement.wallet,
        settledImmediately: settlement.status === 'completed',
      }
    } catch (error) {
      if (isReviewRequired(error)) {
        // The provider says paid but the record does not match this payment: never
        // credit, never fail — flag it for controlled review.
        await flagForReview({
          paymentId: intent.id,
          code: error instanceof Error ? error.message : 'REVIEW_REQUIRED',
          reason: 'The provider result did not match this payment and needs review before any credit',
        })
        return {
          paymentId: intent.id,
          status: 'pending',
          providerReference: record.reference,
          wallet: await readWallet(db, input.userId),
          settledImmediately: false,
          reviewRequired: true,
        }
      }
      throw error
    }
  }

  // Asynchronous provider: the deposit stays pending until a verified webhook.
  await notify(db, {
    userId: intent.userId,
    kind: 'deposit-pending',
    paymentId: intent.id,
    title: 'Deposit pending',
    description: `We are waiting for your provider to confirm ${intent.amountPaise} paise (${record.reference})`,
    createdAt: Date.now(),
  })
  return {
    paymentId: intent.id,
    status: 'pending',
    providerReference: record.reference,
    wallet: await readWallet(db, input.userId),
    settledImmediately: false,
    requiresAction: true,
    checkoutUrl: safeCheckoutUrl(record.checkoutUrl),
    providerOrderId: record.orderId,
  }
}

/** Leaves an indeterminate payment pending and visible to reconciliation. */
async function markIndeterminate(input: { paymentId: string; code: string; reason: string }) {
  await db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.paymentId)
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.paymentId))
      .for('update')
      .limit(1)
    if (!intent) return
    if (intent.status !== 'created') return
    const now = Date.now()
    await tx
      .update(paymentIntents)
      .set({
        status: 'pending',
        providerStatus: 'indeterminate',
        reconciliationStatus: 'pending',
        failureCode: input.code,
        failureReason: input.reason,
        updatedAt: now,
      })
      .where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.status, 'created')))
    await notify(tx, {
      userId: intent.userId,
      kind: 'deposit-pending',
      paymentId: intent.id,
      title: 'Deposit pending',
      description: 'We could not confirm this payment yet. It will update automatically once the provider responds.',
      createdAt: now,
    })
  })
}

function assertDepositAmount(amountPaise: number, config: PaymentConfig) {
  if (!Number.isInteger(amountPaise)) throw new Error('PAYMENT_AMOUNT_INVALID')
  if (amountPaise < MIN_DEPOSIT_PAISE) throw new Error('DEPOSIT_BELOW_MINIMUM')
  if (amountPaise > MAX_DEPOSIT_PAISE) throw new Error('DEPOSIT_ABOVE_MAXIMUM')
  if (config.limits.currency !== SUPPORTED_CURRENCY) throw new Error('UNSUPPORTED_CURRENCY')
}

function assertWithdrawalAmount(amountPaise: number, config: PaymentConfig) {
  if (!Number.isInteger(amountPaise)) throw new Error('PAYMENT_AMOUNT_INVALID')
  if (amountPaise < MIN_WITHDRAWAL_PAISE) throw new Error('WITHDRAWAL_BELOW_MINIMUM')
  if (amountPaise > MAX_WITHDRAWAL_PAISE) throw new Error('WITHDRAWAL_ABOVE_MAXIMUM')
  if (config.limits.currency !== SUPPORTED_CURRENCY) throw new Error('UNSUPPORTED_CURRENCY')
}

/** Records the provider payment on the intent (created -> pending/processing). */
async function recordProviderAccepted(input: { intent: PaymentIntentRowShape; record: ProviderPaymentRecord }) {
  const nextStatus: PaymentStatus = input.record.status === 'processing' ? 'processing' : 'pending'
  await db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.intent.id)
    const [current] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.intent.id))
      .for('update')
      .limit(1)
    if (!current) throw new Error('PAYMENT_NOT_FOUND')
    if (current.status !== 'created') return
    assertPaymentTransition(current.status as PaymentStatus, nextStatus)
    await tx
      .update(paymentIntents)
      .set({
        status: nextStatus,
        providerPaymentId: input.record.id,
        providerReference: input.record.reference,
        providerStatus: input.record.status,
        providerAmountPaise: providerRecordAmount(input.record),
        // Anchor entity, destination handle and hosted checkout link are kept so
        // verification, retries and the user experience stay traceable.
        providerOrderRef: input.record.orderId ?? input.intent.providerOrderRef ?? null,
        providerDestinationRef: input.record.destinationRef ?? input.intent.providerDestinationRef ?? null,
        checkoutUrl: input.record.checkoutUrl ?? input.intent.checkoutUrl ?? null,
        updatedAt: Date.now(),
      })
      .where(and(eq(paymentIntents.id, current.id), eq(paymentIntents.status, 'created')))
  })
}

/**
 * Marks provider truth (`verified`), then applies the wallet + ledger mutation
 * in a second transaction. A crash between the two leaves a `verified` payment
 * with `reconciliationStatus = 'pending'`, which reconciliation reports — the
 * system never pretends the external provider is inside our transaction.
 */
async function markVerifiedAndSettleDeposit(input: {
  intentId: string
  record: ProviderPaymentRecord
}) {
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, input.intentId)).limit(1)
  if (!intent) throw new Error('PAYMENT_NOT_FOUND')
  assertProviderMatchesIntent(intent as PaymentIntentRowShape, input.record)

  await db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.intentId)
    const [current] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.intentId))
      .for('update')
      .limit(1)
    if (!current) throw new Error('PAYMENT_NOT_FOUND')
    if (current.status === 'verified' || current.status === 'completed') return
    assertPaymentTransition(current.status as PaymentStatus, 'verified')
    await tx
      .update(paymentIntents)
      .set({
        status: 'verified',
        providerStatus: input.record.status,
        providerPaymentId: input.record.id,
        providerReference: input.record.reference,
        providerAmountPaise: providerRecordAmount(input.record),
        reconciliationStatus: 'pending',
        updatedAt: Date.now(),
      })
      .where(eq(paymentIntents.id, current.id))
  })

  return settleDeposit({ intentId: input.intentId, record: input.record })
}

/**
 * The single economic effect of a deposit: credit the wallet and write the
 * matching transaction + ledger + notification. Idempotent — a duplicate
 * provider event finds `completed` and returns without touching balances.
 */
async function settleDeposit(input: { intentId: string; record: ProviderPaymentRecord }) {
  return db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.intentId)
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.intentId))
      .for('update')
      .limit(1)
    if (!intent) throw new Error('PAYMENT_NOT_FOUND')
    if (intent.direction !== 'deposit') throw new Error('PAYMENT_DIRECTION_MISMATCH')
    if (intent.status === 'completed') {
      return {
        status: 'completed' as PaymentStatus,
        transactionId: intent.transactionId ?? undefined,
        wallet: await readWallet(tx, intent.userId),
      }
    }
    assertProviderMatchesIntent(intent as PaymentIntentRowShape, input.record)
    assertPaymentTransition(intent.status as PaymentStatus, 'completed')

    const net = intent.netPaise > 0 ? intent.netPaise : intent.amountPaise
    const now = Date.now()
    const [wallet] = await tx
      .update(wallets)
      .set({ availablePaise: sql`${wallets.availablePaise} + ${net}`, updatedAt: new Date() })
      .where(eq(wallets.userId, intent.userId))
      .returning({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
    if (!wallet) throw new Error('ACCOUNT_NOT_READY')

    const transactionId = randomUUID()
    const reference = input.record.reference
    const description = `Deposit via ${intent.method ?? 'provider'}`
    await tx.insert(transactions).values({
      id: transactionId,
      userId: intent.userId,
      reference,
      type: 'deposit',
      amountPaise: net,
      status: 'completed',
      description,
      createdAt: now,
    })
    await tx.insert(ledgerEntries).values({
      id: `ledger_${transactionId}`,
      userId: intent.userId,
      reference,
      type: 'deposit',
      amountPaise: net,
      status: 'completed',
      description,
      createdAt: now,
    })
    const [updated] = await tx
      .update(paymentIntents)
      .set({
        status: 'completed',
        transactionId,
        netPaise: net,
        providerStatus: input.record.status,
        providerPaymentId: input.record.id,
        providerReference: input.record.reference,
        providerAmountPaise: providerRecordAmount(input.record),
        settledAt: now,
        reconciliationStatus: 'unchecked',
        updatedAt: now,
      })
      .where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.status, 'verified')))
      .returning({ id: paymentIntents.id })
    if (!updated) throw new Error('PAYMENT_STATE_CONFLICT')

    await notify(tx, {
      userId: intent.userId,
      kind: 'deposit-settled',
      paymentId: intent.id,
      title: 'Deposit completed',
      description: `${description} · ${reference}`,
      createdAt: now,
    })
    return { status: 'completed' as PaymentStatus, transactionId, wallet }
  })
}

/* ------------------------------------------------------------------ *
 * Withdrawal
 * ------------------------------------------------------------------ */

export async function createWithdrawalPayment(input: {
  userId: string
  amountPaise: number
  destination: string
  requestKey: string
}): Promise<PaymentOperationResult> {
  await ensurePaymentSchema()
  const config = getPaymentConfig()
  // Same posture gate as deposits: no payout is ever queued by a deployment that
  // could not honour the payment mode it was configured for.
  assertPaymentPosture(config)
  assertWithdrawalAmount(input.amountPaise, config)
  await assertPaymentEligibility({ userId: input.userId, direction: 'withdrawal', mode: config.effective, config })
  const provider = getPaymentProvider()

  // Step 1 — reserve the funds and commit the intent atomically. Reserving
  // first means the same money can never be queued for payout twice.
  const prepared = await db.transaction(async (tx) => {
    await lockResource(tx, 'payment-idempotency', input.userId, input.requestKey)
    const [existing] = await tx
      .select()
      .from(paymentIntents)
      .where(and(eq(paymentIntents.userId, input.userId), eq(paymentIntents.requestKey, input.requestKey)))
      .limit(1)
    if (existing) return { replayed: true, intent: existing as PaymentIntentRowShape, wallet: null }

    const [walletBefore] = await tx.select().from(wallets).where(eq(wallets.userId, input.userId)).for('update').limit(1)
    if (!walletBefore) throw new Error('ACCOUNT_NOT_READY')
    if (walletBefore.availablePaise < input.amountPaise) throw new Error('INSUFFICIENT_BALANCE')

    const now = Date.now()
    const paymentId = `pay_${randomUUID()}`
    const transactionId = randomUUID()
    const providerIdempotencyKey = randomUUID()
    const reference = internalReference('WDL', paymentId)
    const [wallet] = await tx
      .update(wallets)
      .set({
        availablePaise: sql`${wallets.availablePaise} - ${input.amountPaise}`,
        lockedPaise: sql`${wallets.lockedPaise} + ${input.amountPaise}`,
        updatedAt: new Date(),
      })
      .where(and(eq(wallets.userId, input.userId), sql`${wallets.availablePaise} >= ${input.amountPaise}`))
      .returning({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
    if (!wallet) throw new Error('INSUFFICIENT_BALANCE')

    const description = `Withdrawal to ${input.destination}`
    await tx.insert(paymentIntents).values({
      id: paymentId,
      userId: input.userId,
      direction: 'withdrawal',
      status: 'created',
      mode: config.effective,
      provider: provider.id,
      currency: SUPPORTED_CURRENCY,
      amountPaise: input.amountPaise,
      feePaise: 0,
      netPaise: input.amountPaise,
      destination: input.destination,
      requestKey: input.requestKey,
      transactionId,
      // A stable UUID for the provider's payout idempotency header: retries reuse
      // the identical key so the provider itself refuses to pay twice.
      providerIdempotencyKey,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(transactions).values({
      id: transactionId,
      userId: input.userId,
      reference,
      type: 'withdrawal',
      amountPaise: -input.amountPaise,
      status: 'pending',
      description,
      createdAt: now,
    })
    await tx.insert(ledgerEntries).values({
      id: `ledger_${transactionId}`,
      userId: input.userId,
      reference,
      type: 'withdrawal',
      amountPaise: -input.amountPaise,
      status: 'pending',
      description,
      createdAt: now,
    })
    await notify(tx, {
      userId: input.userId,
      kind: 'withdrawal-pending',
      paymentId,
      title: 'Withdrawal requested',
      description,
      createdAt: now,
    })
    return { replayed: false, intent: { id: paymentId, userId: input.userId, direction: 'withdrawal', status: 'created', provider: provider.id, currency: SUPPORTED_CURRENCY, amountPaise: input.amountPaise, providerPaymentId: null, providerReference: null, providerStatus: null, providerOrderRef: null, providerDestinationRef: null, providerIdempotencyKey, checkoutUrl: null, feePaise: 0, netPaise: input.amountPaise, requestKey: input.requestKey, destination: input.destination, transactionId, parentPaymentId: null, refundStatus: 'none', mode: config.effective } as PaymentIntentRowShape, wallet }
  })

  const intent = prepared.intent
  if (prepared.replayed) {
    assertIdempotentReplay(intent, {
      direction: 'withdrawal',
      amountPaise: input.amountPaise,
      destination: input.destination,
    })
    return {
      paymentId: intent.id,
      status: intent.status as PaymentStatus,
      transactionId: intent.transactionId ?? undefined,
      providerReference: intent.providerReference ?? undefined,
      wallet: await readWallet(db, input.userId),
      settledImmediately: intent.status === 'completed',
      requiresAction: !['completed', 'failed', 'cancelled', 'expired'].includes(intent.status),
    }
  }

  let record: ProviderPaymentRecord
  try {
    record = await provider.createWithdrawal({
      amountPaise: input.amountPaise,
      currency: SUPPORTED_CURRENCY,
      idempotencyKey: `pay:${intent.id}`,
      destination: input.destination,
      destinationRef: intent.providerDestinationRef ?? undefined,
      internalPaymentId: intent.id,
      providerIdempotencyKey: intent.providerIdempotencyKey ?? undefined,
    })
  } catch (error) {
    const failure = failureOf(error)
    if (isIndeterminateProviderFailure(error)) {
      // The payout request may have reached the provider before the connection
      // broke. The reservation is KEPT (releasing it could hand the user money we
      // are about to pay out) and the payment stays pending for re-check/webhook.
      await markIndeterminate({ paymentId: intent.id, code: failure.code, reason: failure.reason })
      return {
        paymentId: intent.id,
        status: 'pending',
        wallet: await readWallet(db, input.userId),
        settledImmediately: false,
        reviewRequired: true,
      }
    }
    // Provider refused: release the reservation so the balance is whole again.
    await failWithdrawal({ paymentId: intent.id, status: 'failed', code: failure.code, reason: failure.reason })
    return {
      paymentId: intent.id,
      status: 'failed',
      wallet: await readWallet(db, input.userId),
      settledImmediately: false,
    }
  }

  assertProviderMatchesIntent(intent, record)
  await recordProviderAccepted({ intent, record })

  if (record.status === 'failed' || record.status === 'cancelled' || record.status === 'expired') {
    const status: PaymentStatus = record.status === 'cancelled' ? 'cancelled' : record.status === 'expired' ? 'expired' : 'failed'
    await failWithdrawal({
      paymentId: intent.id,
      status,
      code: record.failureCode ?? `PROVIDER_${record.status.toUpperCase()}`,
      reason: record.failureReason ?? 'The provider declined this withdrawal',
    })
    return {
      paymentId: intent.id,
      status,
      providerReference: record.reference,
      wallet: await readWallet(db, input.userId),
      settledImmediately: false,
    }
  }

  if (record.status === 'succeeded') {
    const settlement = await settleWithdrawal({ paymentId: intent.id, record })
    return {
      paymentId: intent.id,
      status: settlement.status,
      transactionId: settlement.transactionId,
      providerReference: record.reference,
      wallet: settlement.wallet,
      settledImmediately: true,
    }
  }

  return {
    paymentId: intent.id,
    status: record.status === 'processing' ? 'processing' : 'pending',
    providerReference: record.reference,
    wallet: await readWallet(db, input.userId),
    settledImmediately: false,
    requiresAction: true,
  }
}

/**
 * Resolves the adapter for a payment that already exists, using the payment's
 * OWN recorded mode. A sandbox payment is therefore always settled through the
 * provider's test mode, never through live credentials.
 */
export function providerForPayment(payment: { provider: string; mode: string }): PaymentProvider | null {
  const mode = payment.mode === 'live' ? 'live' : payment.mode === 'sandbox' ? 'sandbox' : 'demo'
  return getProviderById(payment.provider, mode)
}

/**
 * Provider confirmed the payout: convert the reservation into a final debit.
 * `availablePaise` was already reduced at reservation time, so only the locked
 * balance moves here — the same money can never be withdrawn twice.
 */
async function settleWithdrawal(input: { paymentId: string; record: ProviderPaymentRecord }) {
  return db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.paymentId)
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.paymentId))
      .for('update')
      .limit(1)
    if (!intent) throw new Error('PAYMENT_NOT_FOUND')
    if (intent.direction !== 'withdrawal') throw new Error('PAYMENT_DIRECTION_MISMATCH')
    if (intent.status === 'completed') {
      return {
        status: 'completed' as PaymentStatus,
        transactionId: intent.transactionId ?? undefined,
        wallet: await readWallet(tx, intent.userId),
      }
    }
    assertProviderMatchesIntent(intent as PaymentIntentRowShape, input.record)
    assertPaymentTransition(intent.status as PaymentStatus, 'verified')

    const amount = intent.amountPaise
    const now = Date.now()

    // Provider truth is recorded (status `verified`) BEFORE the balance moves,
    // exactly like the deposit path. The final step below is guarded on
    // `verified -> completed`, so without this write a payout the provider had
    // actually processed could never be finalised: the settlement threw
    // PAYMENT_STATE_CONFLICT, the webhook answered 500, the provider retried
    // forever and the user's funds stayed locked.
    const [verified] = await tx
      .update(paymentIntents)
      .set({
        status: 'verified',
        providerStatus: input.record.status,
        providerPaymentId: input.record.id,
        providerReference: input.record.reference,
        providerAmountPaise: providerRecordAmount(input.record),
        updatedAt: now,
      })
      .where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.status, intent.status)))
      .returning({ id: paymentIntents.id })
    if (!verified) throw new Error('PAYMENT_STATE_CONFLICT')

    const [wallet] = await tx
      .update(wallets)
      .set({ lockedPaise: sql`${wallets.lockedPaise} - ${amount}`, updatedAt: new Date() })
      .where(and(eq(wallets.userId, intent.userId), sql`${wallets.lockedPaise} >= ${amount}`))
      .returning({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
    if (!wallet) throw new Error('LOCK_MISMATCH')

    if (intent.transactionId) {
      await tx
        .update(transactions)
        .set({ status: 'completed' })
        .where(and(eq(transactions.id, intent.transactionId), eq(transactions.status, 'pending')))
      const [settledLedger] = await tx
        .select({ reference: ledgerEntries.reference })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.id, `ledger_${intent.transactionId}`))
        .limit(1)
      if (settledLedger) {
        await tx
          .update(ledgerEntries)
          .set({ status: 'completed' })
          .where(and(eq(ledgerEntries.reference, settledLedger.reference), eq(ledgerEntries.status, 'pending')))
      }
    }

    const [updated] = await tx
      .update(paymentIntents)
      .set({
        status: 'completed',
        providerStatus: input.record.status,
        providerPaymentId: input.record.id,
        providerReference: input.record.reference,
        providerAmountPaise: providerRecordAmount(input.record),
        settledAt: now,
        reconciliationStatus: 'unchecked',
        updatedAt: now,
      })
      .where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.status, 'verified')))
      .returning({ id: paymentIntents.id })
    if (!updated) throw new Error('PAYMENT_STATE_CONFLICT')

    await notify(tx, {
      userId: intent.userId,
      kind: 'withdrawal-settled',
      paymentId: intent.id,
      title: 'Withdrawal completed',
      description: `Sent ${input.record.reference} to ${intent.destination ?? 'your payout destination'}`,
      createdAt: now,
    })
    return { status: 'completed' as PaymentStatus, transactionId: intent.transactionId ?? undefined, wallet }
  })
}

/** Terminal failure: release reserved funds back to the available balance. */
async function failWithdrawal(input: {
  paymentId: string
  status: 'failed' | 'cancelled' | 'expired'
  code: string
  reason: string
}) {
  return db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.paymentId)
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.paymentId))
      .for('update')
      .limit(1)
    if (!intent) throw new Error('PAYMENT_NOT_FOUND')
    if (intent.status === input.status) return { released: false }
    assertPaymentTransition(intent.status as PaymentStatus, input.status)
    const amount = intent.amountPaise
    const now = Date.now()
    const [wallet] = await tx
      .update(wallets)
      .set({
        lockedPaise: sql`${wallets.lockedPaise} - ${amount}`,
        availablePaise: sql`${wallets.availablePaise} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(and(eq(wallets.userId, intent.userId), sql`${wallets.lockedPaise} >= ${amount}`))
      .returning({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
    if (!wallet) throw new Error('LOCK_MISMATCH')

    if (intent.transactionId) {
      await tx
        .update(transactions)
        .set({ status: 'failed' })
        .where(and(eq(transactions.id, intent.transactionId), eq(transactions.status, 'pending')))
      const [releasedLedger] = await tx
        .select({ reference: ledgerEntries.reference })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.id, `ledger_${intent.transactionId}`))
        .limit(1)
      if (releasedLedger) {
        await tx
          .update(ledgerEntries)
          .set({ status: 'failed' })
          .where(and(eq(ledgerEntries.reference, releasedLedger.reference), eq(ledgerEntries.status, 'pending')))
      }
    }

    await tx
      .update(paymentIntents)
      .set({ status: input.status, failureCode: input.code, failureReason: input.reason, updatedAt: now })
      .where(eq(paymentIntents.id, intent.id))

    const cancelled = input.status === 'cancelled'
    await notify(tx, {
      userId: intent.userId,
      kind: cancelled ? 'withdrawal-cancelled' : 'withdrawal-failed',
      paymentId: intent.id,
      title: cancelled ? 'Withdrawal cancelled' : 'Withdrawal failed',
      description: `${input.reason}. The reserved funds are back in your available balance.`,
      createdAt: now,
    })
    return { released: true, wallet }
  })
}

/** Terminal failure for a deposit: no wallet mutation at all. */
async function failPayment(input: { paymentId: string; status: 'failed' | 'cancelled' | 'expired'; code: string; reason: string }) {
  return db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.paymentId)
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.paymentId))
      .for('update')
      .limit(1)
    if (!intent) throw new Error('PAYMENT_NOT_FOUND')
    if (intent.status === input.status || intent.status === 'completed') return intent
    assertPaymentTransition(intent.status as PaymentStatus, input.status)
    const now = Date.now()
    await tx
      .update(paymentIntents)
      .set({ status: input.status, failureCode: input.code, failureReason: input.reason, updatedAt: now })
      .where(eq(paymentIntents.id, intent.id))
    await notify(tx, {
      userId: intent.userId,
      kind: 'deposit-failed',
      paymentId: intent.id,
      title: 'Deposit failed',
      description: input.reason,
      createdAt: now,
    })
    return { ...intent, status: input.status }
  })
}

/* ------------------------------------------------------------------ *
 * Refund (admin)
 * ------------------------------------------------------------------ */

export interface RefundResult {
  transactionId: string
  amountPaise: number
  status: PaymentStatus
  wallet: WalletSnapshot
  /**
   * True when this call resolved to a refund that already existed instead of
   * issuing a new one (REPLAY of the same transaction). The accounting effect is
   * identical — no money moves a second time — but the caller must be able to
   * tell "one refund happened now" from "this was already refunded", so the
   * admin route can answer 409 instead of reporting a fresh success.
   */
  replayed: boolean
}

/**
 * Admin refund. Preserves the original behaviour (reverse a completed deposit,
 * or cancel a pending withdrawal by unlocking its funds) while adding the
 * accounting record, provider reference, notification and audit entry.
 *
 * Full refunds only: partial refunds are not part of the data model yet, and
 * the unique `<reference>-REFUND` transaction plus the refund intent's
 * idempotency key make a double refund impossible.
 */
export async function refundTransaction(input: {
  adminUserId: string
  transactionId: string
  reason?: string
}): Promise<RefundResult> {
  await ensurePaymentSchema()
  const config = getPaymentConfig()
  const requestKey = `refund:${input.transactionId}`

  const anchor = await db.transaction(async (tx) => {
    await lockResource(tx, 'refund', input.transactionId)
    const [original] = await tx
      .select()
      .from(transactions)
      .where(eq(transactions.id, input.transactionId))
      .for('update')
      .limit(1)
    if (!original) throw new Error('UNKNOWN_TRANSACTION')

    const [existingRefund] = await tx
      .select()
      .from(paymentIntents)
      .where(and(eq(paymentIntents.userId, original.userId), eq(paymentIntents.requestKey, requestKey)))
      .limit(1)
    if (existingRefund) {
      return { replayed: true as const, refund: existingRefund as PaymentIntentRowShape, original }
    }

    const isDeposit = original.type === 'deposit' && original.status === 'completed'
    const isWithdrawal = original.type === 'withdrawal' && original.status === 'pending'
    if (!isDeposit && !isWithdrawal) throw new Error('NOT_REFUNDABLE')

    const amount = Math.abs(original.amountPaise)
    const [walletBefore] = await tx.select().from(wallets).where(eq(wallets.userId, original.userId)).for('update').limit(1)
    if (!walletBefore) throw new Error('ACCOUNT_NOT_READY')
    if (isWithdrawal && walletBefore.lockedPaise < amount) throw new Error('LOCK_MISMATCH')
    if (isDeposit && walletBefore.availablePaise < amount) throw new Error('INSUFFICIENT_BALANCE')

    const [parent] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.transactionId, original.id))
      .limit(1)

    const now = Date.now()
    const refundId = `pay_${randomUUID()}`
    await tx.insert(paymentIntents).values({
      id: refundId,
      userId: original.userId,
      direction: 'refund',
      status: 'created',
      mode: parent?.mode ?? config.effective,
      provider: parent?.provider ?? config.providerId,
      currency: parent?.currency ?? SUPPORTED_CURRENCY,
      amountPaise: amount,
      feePaise: 0,
      netPaise: amount,
      parentPaymentId: parent?.id ?? null,
      requestKey,
      createdAt: now,
      updatedAt: now,
    })
    return {
      replayed: false as const,
      refund: {
        id: refundId,
        userId: original.userId,
        direction: 'refund',
        status: 'created',
        provider: parent?.provider ?? config.providerId,
        currency: parent?.currency ?? SUPPORTED_CURRENCY,
        amountPaise: amount,
        providerPaymentId: null,
        providerReference: null,
        providerStatus: null,
        feePaise: 0,
        netPaise: amount,
        requestKey,
        destination: null,
        transactionId: null,
        parentPaymentId: parent?.id ?? null,
        refundStatus: 'none',
        mode: parent?.mode ?? config.effective,
      } as PaymentIntentRowShape,
      parent: parent as PaymentIntentRowShape | undefined,
      original,
    }
  })

  if (anchor.replayed) {
    return {
      transactionId: anchor.refund.id,
      amountPaise: anchor.refund.amountPaise,
      status: anchor.refund.status as PaymentStatus,
      wallet: await readWallet(db, anchor.refund.userId),
      replayed: true,
    }
  }

  const provider = providerForPayment(anchor.refund) ?? getPaymentProvider()
  const parent = anchor.parent

  let record: ProviderPaymentRecord
  try {
    record = await provider.refundPayment({
      amountPaise: anchor.refund.amountPaise,
      currency: anchor.refund.currency,
      idempotencyKey: `refund:${parent?.id ?? input.transactionId}`,
      originalProviderPaymentId: parent?.providerPaymentId ?? anchor.original.reference,
      originalReference: anchor.original.reference,
      partial: false,
      // Association: the provider echoes our internal refund id back, which is
      // what lets `assertProviderMatchesRefund` reject a refund record that
      // belongs to a different payment.
      internalPaymentId: anchor.refund.id,
    })
  } catch (error) {
    const failure = failureOf(error)
    await failRefund({ refundId: anchor.refund.id, code: failure.code, reason: failure.reason, adminUserId: input.adminUserId })
    throw new Error('REFUND_FAILED')
  }

  if (record.status === 'succeeded') {
    try {
      const applied = await applyRefundSettlement({
        refundId: anchor.refund.id,
        record,
        adminUserId: input.adminUserId,
        reason: input.reason,
      })
      return applied
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PAYMENT_REFUND_FAILED'
      if (REVIEW_CODES.has(code) || code === 'INVALID_PAYMENT_TRANSITION' || code === 'NOT_REFUNDABLE') {
        // The provider says the refund succeeded but its record contradicts our
        // intent (amount, currency or association). Money is NOT moved and the
        // divergence is handed to a human instead of being applied blindly.
        await flagForReview({
          paymentId: anchor.refund.id,
          code,
          reason: 'The provider refunded an amount or reference that does not match this refund',
          actorUserId: input.adminUserId,
        }).catch(() => undefined)
        throw new Error('REFUND_REVIEW_REQUIRED')
      }
      throw error
    }
  }

  if (record.status === 'failed' || record.status === 'cancelled' || record.status === 'expired') {
    await failRefund({
      refundId: anchor.refund.id,
      code: record.failureCode ?? 'PROVIDER_REFUND_FAILED',
      reason: record.failureReason ?? 'The provider declined the refund',
      adminUserId: input.adminUserId,
    })
    throw new Error('REFUND_FAILED')
  }

  // Asynchronous refund: the wallet move happens when the provider event lands,
  // so the provider reference MUST be stored now — that is the only way the
  // provider's own refund webhook can find and settle THIS refund. Without it
  // the refund intent had no provider payment id, the webhook was matched to
  // nothing and the money stayed credited even though the provider had refunded.
  await recordRefundProviderReference({ refundId: anchor.refund.id, record })
  return {
    transactionId: anchor.refund.id,
    amountPaise: anchor.refund.amountPaise,
    status: 'pending',
    wallet: await readWallet(db, anchor.refund.userId),
    replayed: false,
  }
}

/** Stores provider truth on a refund awaiting an asynchronous provider outcome. */
async function recordRefundProviderReference(input: { refundId: string; record: ProviderPaymentRecord }) {
  await db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.refundId)
    const [refund] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.refundId))
      .for('update')
      .limit(1)
    if (!refund) return
    if (refund.status === 'completed' || refund.status === 'failed') return
    await tx
      .update(paymentIntents)
      .set({
        providerStatus: input.record.status,
        providerPaymentId: input.record.id,
        providerReference: input.record.reference,
        providerAmountPaise: providerRecordAmount(input.record),
        updatedAt: Date.now(),
      })
      .where(eq(paymentIntents.id, refund.id))
  })
}

/**
 * Applies the refund's accounting effect exactly once. Also used by the webhook
 * path for providers that confirm refunds asynchronously.
 */
async function applyRefundSettlement(input: {
  refundId: string
  record: ProviderPaymentRecord
  adminUserId?: string
  reason?: string
}): Promise<RefundResult> {
  return db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.refundId)
    const [refund] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.refundId))
      .for('update')
      .limit(1)
    if (!refund) throw new Error('PAYMENT_NOT_FOUND')
    if (refund.status === 'completed') {
      return {
        transactionId: refund.transactionId ?? refund.id,
        amountPaise: refund.amountPaise,
        status: 'completed' as PaymentStatus,
        wallet: await readWallet(tx, refund.userId),
        replayed: false,
      }
    }
    if (refund.direction !== 'refund') throw new Error('PAYMENT_DIRECTION_MISMATCH')
    // Verified BEFORE the state transition and before any wallet write: a
    // provider record that does not match this refund never moves money.
    assertProviderMatchesRefund(refund as PaymentIntentRowShape, input.record)
    assertPaymentTransition(refund.status as PaymentStatus, 'verified')

    const parentId = refund.parentPaymentId
    const [parent] = parentId
      ? await tx.select().from(paymentIntents).where(eq(paymentIntents.id, parentId)).for('update').limit(1)
      : []
    const originalId = parent?.transactionId
    const [original] = originalId
      ? await tx.select().from(transactions).where(eq(transactions.id, originalId)).for('update').limit(1)
      : []

    if (original) {
      const stillRefundable = (original.type === 'deposit' && original.status === 'completed') ||
        (original.type === 'withdrawal' && original.status === 'pending')
      if (!stillRefundable) throw new Error('NOT_REFUNDABLE')
    }

    const amount = refund.amountPaise
    const isWithdrawalReversal = original?.type === 'withdrawal'
    const now = Date.now()
    const [wallet] = await tx
      .update(wallets)
      .set(
        isWithdrawalReversal
          ? {
            lockedPaise: sql`${wallets.lockedPaise} - ${amount}`,
            availablePaise: sql`${wallets.availablePaise} + ${amount}`,
            updatedAt: new Date(),
          }
          : {
            availablePaise: sql`${wallets.availablePaise} - ${amount}`,
            updatedAt: new Date(),
          },
      )
      .where(and(
        eq(wallets.userId, refund.userId),
        isWithdrawalReversal ? sql`${wallets.lockedPaise} >= ${amount}` : sql`${wallets.availablePaise} >= ${amount}`,
      ))
      .returning({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
    if (!wallet) throw new Error(isWithdrawalReversal ? 'LOCK_MISMATCH' : 'INSUFFICIENT_BALANCE')

    if (original && isWithdrawalReversal) {
      await tx
        .update(transactions)
        .set({ status: 'failed' })
        .where(and(eq(transactions.id, original.id), eq(transactions.status, 'pending')))
      const [reservation] = await tx
        .select({ reference: ledgerEntries.reference })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.id, `ledger_${original.id}`))
        .limit(1)
      if (reservation) {
        await tx
          .update(ledgerEntries)
          .set({ status: 'failed' })
          .where(and(eq(ledgerEntries.reference, reservation.reference), eq(ledgerEntries.status, 'pending')))
      }
    }

    const label = isWithdrawalReversal ? 'Withdrawal cancelled' : 'Deposit reversed'
    const description = input.reason ? `${label} by admin — ${input.reason}` : `${label} by admin`
    const refundAmountPaise = isWithdrawalReversal ? amount : -amount
    const refundReference = `${original?.reference ?? refund.parentPaymentId ?? refund.id}-REFUND`
    const refundTransactionId = randomUUID()

    await tx.insert(transactions).values({
      id: refundTransactionId,
      userId: refund.userId,
      reference: refundReference,
      type: 'refund',
      amountPaise: refundAmountPaise,
      status: 'completed',
      description,
      marketId: original?.marketId ?? null,
      createdAt: now,
    })
    // Ledger booking. A deposit reversal is a real money movement, so it gets its
    // own accounting entry. A withdrawal reversal only returns a HELD amount to
    // the spendable balance: the hold never changed the ledger total (its entry
    // was written `pending` and is voided above), so booking a credit here would
    // count the same money twice and break the wallet/ledger equation. The refund
    // transaction row below still records it in the user's history.
    if (!isWithdrawalReversal) {
      await tx.insert(ledgerEntries).values({
        id: `ledger_${refundTransactionId}`,
        userId: refund.userId,
        reference: refundReference,
        type: 'refund',
        amountPaise: refundAmountPaise,
        status: 'completed',
        description,
        marketId: original?.marketId ?? null,
        createdAt: now,
      })
    }

    await tx
      .update(paymentIntents)
      .set({
        status: 'completed',
        transactionId: refundTransactionId,
        providerStatus: input.record.status,
        providerPaymentId: input.record.id,
        providerReference: input.record.reference,
        providerAmountPaise: providerRecordAmount(input.record),
        refundStatus: 'full',
        settledAt: now,
        reconciliationStatus: 'unchecked',
        updatedAt: now,
      })
      .where(eq(paymentIntents.id, refund.id))

    if (parent) {
      const parentNextStatus: PaymentStatus = isWithdrawalReversal ? 'cancelled' : 'refunded'
      if (parent.status !== parentNextStatus) {
        await tx
          .update(paymentIntents)
          .set({ status: parentNextStatus, refundStatus: 'full', updatedAt: now })
          .where(eq(paymentIntents.id, parent.id))
      }
    }

    await notify(tx, {
      userId: refund.userId,
      kind: 'refund-settled',
      paymentId: refund.id,
      title: isWithdrawalReversal ? 'Withdrawal cancelled' : 'Deposit refunded',
      description,
      createdAt: now,
    })

    await recordAudit(
      {
        actorRole: input.adminUserId ? 'admin' : 'system',
        actorUserId: input.adminUserId,
        action: AUDIT_ACTIONS.refundIssued,
        entityType: 'paymentIntent',
        entityId: refund.id,
        summary: `${description} · ${refundReference}`,
        metadata: {
          parentPaymentId: parent?.id ?? null,
          amountPaise: amount,
          provider: refund.provider,
          providerReference: input.record.reference,
        },
      },
      tx,
    )

    return {
      transactionId: refundTransactionId,
      amountPaise: amount,
      status: 'completed' as PaymentStatus,
      wallet,
      replayed: false,
    }
  })
}

async function failRefund(input: { refundId: string; code: string; reason: string; adminUserId?: string }) {
  await db.transaction(async (tx) => {
    await lockResource(tx, 'payment', input.refundId)
    const [refund] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, input.refundId))
      .for('update')
      .limit(1)
    if (!refund) throw new Error('PAYMENT_NOT_FOUND')
    if (refund.status === 'failed' || refund.status === 'completed') return
    assertPaymentTransition(refund.status as PaymentStatus, 'failed')
    const now = Date.now()
    await tx
      .update(paymentIntents)
      .set({ status: 'failed', failureCode: input.code, failureReason: input.reason, updatedAt: now })
      .where(eq(paymentIntents.id, refund.id))
    await notify(tx, {
      userId: refund.userId,
      kind: 'refund-failed',
      paymentId: refund.id,
      title: 'Refund failed',
      description: input.reason,
      createdAt: now,
    })
    await recordAudit(
      {
        actorRole: input.adminUserId ? 'admin' : 'system',
        actorUserId: input.adminUserId,
        action: AUDIT_ACTIONS.refundFailed,
        entityType: 'paymentIntent',
        entityId: refund.id,
        summary: `Refund failed: ${input.reason}`,
        metadata: { code: input.code, provider: refund.provider },
      },
      tx,
    )
  })
}

/* ------------------------------------------------------------------ *
 * Admin withdrawal resolution
 * ------------------------------------------------------------------ */

export async function resolveWithdrawal(input: {
  adminUserId: string
  paymentId: string
  action: 'complete' | 'fail' | 'cancel'
  reason?: string
}): Promise<{ status: PaymentStatus; wallet: WalletSnapshot }> {
  await ensurePaymentSchema()
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, input.paymentId)).limit(1)
  if (!intent) throw new Error('PAYMENT_NOT_FOUND')
  if (intent.direction !== 'withdrawal') throw new Error('PAYMENT_DIRECTION_MISMATCH')
  if (['completed', 'failed', 'cancelled', 'expired'].includes(intent.status)) throw new Error('PAYMENT_ALREADY_FINAL')

  const provider = providerForPayment(intent)
  if (!provider) throw new Error('PROVIDER_UNKNOWN')

  if (input.action === 'cancel') {
    if (provider.capabilities.cancelWithdrawal && intent.providerPaymentId) {
      await provider.cancelWithdrawal({
        paymentId: intent.providerPaymentId,
        idempotencyKey: `cancel:${intent.id}`,
        reason: input.reason,
      })
    }
    await failWithdrawal({
      paymentId: intent.id,
      status: 'cancelled',
      code: 'ADMIN_CANCELLED',
      reason: input.reason || 'Cancelled by an administrator',
    })
    await recordAudit({
      actorRole: 'admin',
      actorUserId: input.adminUserId,
      action: AUDIT_ACTIONS.withdrawalCancelled,
      entityType: 'paymentIntent',
      entityId: intent.id,
      summary: `Withdrawal cancelled${input.reason ? ` — ${input.reason}` : ''}`,
      metadata: { amountPaise: intent.amountPaise, provider: intent.provider },
    })
    return { status: 'cancelled', wallet: await readWallet(db, intent.userId) }
  }

  if (input.action === 'complete') {
    if (!intent.providerPaymentId) throw new Error('PROVIDER_PAYMENT_MISSING')
    const record = await provider.verifyPayment(intent.providerPaymentId)
    if (record.status !== 'succeeded') throw new Error('PROVIDER_NOT_SETTLED')
    const settlement = await settleWithdrawal({ paymentId: intent.id, record })
    await recordAudit({
      actorRole: 'admin',
      actorUserId: input.adminUserId,
      action: AUDIT_ACTIONS.withdrawalCompleted,
      entityType: 'paymentIntent',
      entityId: intent.id,
      summary: `Withdrawal marked completed${input.reason ? ` — ${input.reason}` : ''}`,
      metadata: { amountPaise: intent.amountPaise, providerReference: record.reference },
    })
    return { status: settlement.status, wallet: settlement.wallet }
  }

  await failWithdrawal({
    paymentId: intent.id,
    status: 'failed',
    code: 'ADMIN_MARKED_FAILED',
    reason: input.reason || 'Marked failed by an administrator',
  })
  await recordAudit({
    actorRole: 'admin',
    actorUserId: input.adminUserId,
    action: AUDIT_ACTIONS.withdrawalFailed,
    entityType: 'paymentIntent',
    entityId: intent.id,
    summary: `Withdrawal marked failed${input.reason ? ` — ${input.reason}` : ''}`,
    metadata: { amountPaise: intent.amountPaise, provider: intent.provider },
  })
  return { status: 'failed', wallet: await readWallet(db, intent.userId) }
}

/* ------------------------------------------------------------------ *
 * Verified provider events (webhooks)
 * ------------------------------------------------------------------ */

/**
 * Applies a signature-verified provider event. Callers must have verified the
 * webhook before calling this — the `payment_webhook_event` row recorded by the
 * webhook layer is what guarantees one economic effect per event.
 */
export async function applyProviderEvent(input: {
  providerId: string
  event: ProviderWebhookEvent
}): Promise<ApplyProviderEventResult> {
  await ensurePaymentSchema()
  const provider = getProviderById(input.providerId)
  if (!provider) return { handled: false, reason: 'PROVIDER_UNKNOWN' }


  const [intent] = await db
    .select()
    .from(paymentIntents)
    .where(and(eq(paymentIntents.provider, input.providerId), eq(paymentIntents.providerPaymentId, input.event.paymentId)))
    .limit(1)

  let resolved = intent as PaymentIntentRowShape | undefined

  if (!resolved) {
    const [byReference] = await db
      .select()
      .from(paymentIntents)
      .where(and(eq(paymentIntents.provider, input.providerId), eq(paymentIntents.providerReference, input.event.reference)))
      .limit(1)
    resolved = byReference as PaymentIntentRowShape | undefined
  }

  if (!resolved && input.event.orderId) {
    // A deposit is created against a provider ORDER and only later acquires a
    // payment id, so the capture event is matched through the anchor entity the
    // order id identifies. Without this a real capture would look like an
    // unknown payment and the user's money would never be credited.
    const [byOrder] = await db
      .select()
      .from(paymentIntents)
      .where(and(
        eq(paymentIntents.provider, input.providerId),
        eq(paymentIntents.providerOrderRef, input.event.orderId),
        eq(paymentIntents.direction, input.event.direction),
      ))
      .limit(1)
    resolved = byOrder as PaymentIntentRowShape | undefined
  }

  if (!resolved) return { handled: false, reason: 'PAYMENT_NOT_FOUND', duplicate: false }
  return routeProviderEvent({ intent: resolved, event: input.event, config: getPaymentConfig() })
}

async function routeProviderEvent(input: {
  intent: PaymentIntentRowShape
  event: ProviderWebhookEvent
  config: PaymentConfig
}): Promise<ApplyProviderEventResult> {
  const { intent, event } = input
  if (intent.direction !== event.direction) {
    return { handled: false, reason: 'PAYMENT_DIRECTION_MISMATCH', paymentId: intent.id }
  }
  // A provider event can only settle payments created against that provider in
  // the same mode: a demo event can never settle a sandbox/live payment.
  //
  // The payment's OWN recorded mode is authoritative here. Resolving the adapter
  // without a mode prefers live credentials whenever both key pairs are present
  // (which is exactly the state of a controlled test -> live cutover), and then
  // every sandbox payment's webhook was judged against the live adapter and
  // rejected as a mode mismatch — so sandbox deposits silently never settled.
  const intentMode = intent.mode === 'live' ? 'live' : intent.mode === 'demo' ? 'demo' : 'sandbox'
  const eventProvider = getProviderById(intent.provider, intentMode)
  if (!eventProvider) {
    return { handled: false, reason: 'PROVIDER_UNKNOWN', paymentId: intent.id }
  }
  if (eventProvider.mode !== intent.mode) {
    return { handled: false, reason: 'MODE_MISMATCH', paymentId: intent.id }
  }

  const record: ProviderPaymentRecord = {
    id: event.paymentId,
    reference: event.reference,
    direction: event.direction,
    status: event.status,
    amountPaise: event.amountPaise,
    currency: event.currency,
    idempotencyKey: `event:${event.providerEventId}`,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    // Association carried by the event itself (order receipt/notes echoed by the
    // provider). Passing it through means the same amount/currency/reference/
    // account verification that guards a direct provider response also guards a
    // webhook: an event that names a different internal payment, order or
    // merchant account can never settle this one.
    orderId: event.orderId,
    internalPaymentId: event.internalPaymentId,
    accountId: event.accountId,
  }

  try {
    if (event.status === 'succeeded') {
      if (intent.direction === 'deposit') {
        const settlement = await markVerifiedAndSettleDeposit({ intentId: intent.id, record })
        return { handled: true, paymentId: intent.id, duplicate: settlement.status === 'completed' && intent.status === 'completed' }
      }
      if (intent.direction === 'withdrawal') {
        await recordProviderAccepted({ intent, record })
        const settlement = await settleWithdrawal({ paymentId: intent.id, record })
        return { handled: true, paymentId: intent.id }
      }
      const applied = await applyRefundSettlement({ refundId: intent.id, record })
      return { handled: true, paymentId: intent.id, duplicate: applied.status === 'completed' && intent.status === 'completed' }
    }

    if (event.status === 'pending' || event.status === 'processing' || event.status === 'created') {
      await recordProviderAccepted({ intent, record })
      if (intent.status === 'pending' || intent.status === 'processing') return { handled: true, paymentId: intent.id }
      await db
        .update(paymentIntents)
        .set({ status: event.status === 'processing' ? 'processing' : 'pending', providerStatus: event.status, updatedAt: Date.now() })
        .where(and(eq(paymentIntents.id, intent.id), eq(paymentIntents.status, intent.status)))
      return { handled: true, paymentId: intent.id }
    }

    const terminal: 'failed' | 'cancelled' | 'expired' = event.status === 'cancelled' ? 'cancelled' : event.status === 'expired' ? 'expired' : 'failed'
    if (intent.direction === 'withdrawal') {
      await failWithdrawal({
        paymentId: intent.id,
        status: terminal,
        code: `PROVIDER_${event.status.toUpperCase()}`,
        reason: 'The provider reported this payout as unsuccessful',
      })
      return { handled: true, paymentId: intent.id }
    }
    if (intent.direction === 'refund') {
      await failRefund({ refundId: intent.id, code: `PROVIDER_${event.status.toUpperCase()}`, reason: 'The provider reported this refund as unsuccessful' })
      return { handled: true, paymentId: intent.id }
    }
    if (isSettledPaymentStatus(intent.status as PaymentStatus)) {
      // The provider now says this deposit failed, but the wallet was already
      // credited for it. The settled state and the money are preserved and the
      // conflict is handed to a human instead of being swallowed, which is the
      // whole point of out-of-order/contradictory event handling.
      await flagForReview({
        paymentId: intent.id,
        code: `PROVIDER_${event.status.toUpperCase()}_AFTER_SETTLEMENT`,
        reason: 'The provider reported a failure for a deposit that was already credited',
      })
      return { handled: false, reason: 'FINAL_STATE_PRESERVED:PAYMENT_ALREADY_SETTLED', paymentId: intent.id }
    }
    await failPayment({
      paymentId: intent.id,
      status: terminal,
      code: `PROVIDER_${event.status.toUpperCase()}`,
      reason: 'The provider reported this deposit as unsuccessful',
    })
    return { handled: true, paymentId: intent.id }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'PAYMENT_EVENT_FAILED'
    if (code === 'INVALID_PAYMENT_TRANSITION' || REVIEW_CODES.has(code) || code === 'NOT_REFUNDABLE') {
      // Provider truth contradicts a final internal state — most often a payout
      // reversal or a second refund arriving after we already settled. The
      // settled state is PRESERVED (never blindly overwritten), the divergence is
      // flagged for controlled review, and the delivery is acknowledged so the
      // provider does not retry the same impossible transition forever.
      await flagForReview({
        paymentId: intent.id,
        code,
        reason: 'The provider reported a state that conflicts with this payment\u2019s final state',
      }).catch(() => undefined)
      return { handled: false, reason: `FINAL_STATE_PRESERVED:${code}`, paymentId: intent.id }
    }
    // Anything else is re-thrown so the webhook layer records the event as failed
    // and the provider retries; the intent keeps its state and stays reconcilable.
    throw error
  }
}

/** Re-drives a stuck payment from currently known provider truth (admin action). */
export async function retryPayment(input: { adminUserId: string; paymentId: string }) {
  await ensurePaymentSchema()
  const [intent] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, input.paymentId)).limit(1)
  if (!intent) throw new Error('PAYMENT_NOT_FOUND')
  const provider = providerForPayment(intent)
  if (!provider) throw new Error('PROVIDER_UNKNOWN')
  if (!intent.providerPaymentId) throw new Error('PROVIDER_PAYMENT_MISSING')

  await recordAudit({
    actorRole: 'admin',
    actorUserId: input.adminUserId,
    action: AUDIT_ACTIONS.paymentRetried,
    entityType: 'paymentIntent',
    entityId: intent.id,
    summary: `Payment retry requested while status was ${describePaymentStatus(intent.status as PaymentStatus)}`,
    metadata: { provider: intent.provider },
  })

  const record = await provider.verifyPayment(intent.providerPaymentId)
  return applyProviderEvent({
    providerId: intent.provider,
    event: {
      providerEventId: `retry:${intent.id}:${record.status}:${Date.now()}`,
      eventType: `retry.${intent.direction}.${record.status}`,
      direction: intent.direction as PaymentDirection,
      paymentId: record.id,
      reference: record.reference,
      status: record.status,
      amountPaise: record.amountPaise,
      currency: record.currency,
      occurredAt: Date.now(),
    },
  })
}
