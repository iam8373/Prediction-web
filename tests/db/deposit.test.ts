import 'server-only'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { createDepositPayment } from '@/lib/payments/service'
import { getPaymentConfig } from '@/lib/payments/config'
import {
  auditRowsFor,
  closePool,
  createTestUser,
  databaseUrl,
  ledgerForUser,
  notificationsForUser,
  rawSql,
  readPayment,
  readWallet,
  resetDatabase,
  transactionsForUser,
  webhookEventsFor,
} from './harness.ts'
import { configureSandboxEnv, deliverWebhook, providerOutcomeWebhook, sandboxEvent } from './sandbox.ts'

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'
const AMOUNT = 25_000 // ₹250 in integer paise

before(async () => {
  if (skip) return
  configureSandboxEnv()
  await resetDatabase()
})

describe('Deposit E2E against PostgreSQL', () => {
  test('sandbox mode is active and live money is refused', { skip }, () => {
    const config = getPaymentConfig()
    assert.equal(config.effective, 'sandbox')
    assert.equal(config.liveEnabled, false)
    assert.notEqual(config.providerId, 'demo')
  })

  test('a created deposit does not move money and returns provider checkout data', { skip }, async () => {
    const { userId } = await createTestUser()
    const result = await createDepositPayment({ userId, amountPaise: AMOUNT, method: 'upi', requestKey: 'req-happy' })

    assert.equal(result.status, 'pending', 'an async provider must not settle inside the create call')
    assert.equal(result.settledImmediately, false)
    assert.equal(result.requiresAction, true)

    const payment = await readPayment(result.paymentId)
    assert.ok(payment)
    assert.equal(payment.status, 'pending')
    assert.equal(payment.mode, 'sandbox')
    assert.equal(payment.provider, 'sandbox')
    assert.equal(payment.direction, 'deposit')
    assert.equal(Number(payment.amountPaise), AMOUNT, 'amounts stay integer paise')
    assert.equal(payment.currency, 'INR')
    assert.equal(payment.requestKey, 'req-happy')
    assert.ok(payment.providerPaymentId, 'a provider payment id must be recorded before any settlement')
    assert.ok(payment.providerIdempotencyKey === null || typeof payment.providerIdempotencyKey === 'string')

    // Opening the payment page is NOT confirmation: no wallet, transaction or ledger movement yet.
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), 0)
    assert.equal(Number(wallet.lockedPaise), 0)
    assert.equal((await transactionsForUser(userId)).length, 0)
    assert.equal((await ledgerForUser(userId)).length, 0)
  })

  test('a signed provider webhook credits the wallet exactly once', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: AMOUNT, method: 'upi', requestKey: 'req-confirm' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    const event = providerOutcomeWebhook(payment.providerPaymentId, 'succeeded')
    const response = await deliverWebhook(event)
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)

    const settled = await readPayment(created.paymentId)
    assert.equal(settled?.status, 'completed')
    assert.ok(settled?.settledAt, 'a completed payment records its settlement time')
    assert.ok(settled?.transactionId, 'the settlement writes a transaction')

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), AMOUNT, 'the wallet receives exactly the deposit amount')
    assert.equal(Number(wallet.lockedPaise), 0)

    const transactions = await transactionsForUser(userId)
    assert.equal(transactions.length, 1, 'exactly one transaction')
    assert.equal(transactions[0].type, 'deposit')
    assert.equal(transactions[0].status, 'completed')
    assert.equal(Number(transactions[0].amountPaise), AMOUNT)
    assert.equal(transactions[0].reference, payment.providerReference)

    const ledger = await ledgerForUser(userId)
    assert.equal(ledger.length, 1, 'exactly one ledger movement')
    assert.equal(ledger[0].type, 'deposit')
    assert.equal(Number(ledger[0].amountPaise), AMOUNT)
    assert.equal(ledger[0].status, 'completed')

    const notifications = await notificationsForUser(userId)
    assert.ok(notifications.length >= 1, 'the user is notified after an authoritative transition')

    const webhookRows = await webhookEventsFor(created.paymentId)
    assert.equal(webhookRows.length, 1)
    assert.equal(webhookRows[0].status, 'processed')

    const audits = await auditRowsFor(created.paymentId)
    assert.ok(audits.length >= 1, 'the settlement leaves an audit trail')
  })

  test('the identical webhook delivery twice is a no-op', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey: 'req-dup' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    const event = providerOutcomeWebhook(payment.providerPaymentId, 'succeeded')
    assert.equal((await deliverWebhook(event)).status, 200)
    const first = await readWallet(userId)

    const second = await deliverWebhook(event)
    assert.equal(second.status, 200)
    assert.equal(second.body.duplicate, true)

    const after = await readWallet(userId)
    assert.equal(Number(after.availablePaise), Number(first.availablePaise), 'a duplicate delivery must not credit again')
    assert.equal((await transactionsForUser(userId)).length, 1)
    assert.equal((await ledgerForUser(userId)).length, 1)
    assert.equal((await webhookEventsFor(created.paymentId)).length, 1, 'the event id is unique in the database')
  })

  test('a second success event with a NEW event id cannot credit twice', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey: 'req-resent' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    assert.equal((await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'succeeded'))).status, 200)
    const first = await readWallet(userId)

    const resent = sandboxEvent({
      type: 'payment.succeeded',
      paymentId: payment.providerPaymentId,
      amountPaise: AMOUNT,
      reference: payment.providerReference ?? payment.providerPaymentId,
    })
    const response = await deliverWebhook(resent)
    assert.equal(response.status, 200)

    const after = await readWallet(userId)
    assert.equal(Number(after.availablePaise), Number(first.availablePaise))
    assert.equal((await transactionsForUser(userId)).length, 1, 'one payment, one credit')
    assert.equal((await ledgerForUser(userId)).length, 1, 'one payment, one ledger movement')
  })

  test('an out-of-order failure event cannot overwrite a settled deposit', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey: 'req-order' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    assert.equal((await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'succeeded'))).status, 200)
    const credited = await readWallet(userId)

    const lateFailure = sandboxEvent({
      type: 'payment.failed',
      paymentId: payment.providerPaymentId,
      amountPaise: AMOUNT,
      reference: payment.providerReference ?? payment.providerPaymentId,
    })
    const response = await deliverWebhook(lateFailure)
    assert.equal(response.status, 200, 'the delivery is acknowledged, not retried forever')

    const after = await readPayment(created.paymentId)
    assert.equal(after?.status, 'completed', 'a settled payment can never be moved back to failed')
    assert.equal(Number((await readWallet(userId)).availablePaise), Number(credited.availablePaise))
    assert.equal(after?.reconciliationStatus, 'mismatch', 'the contradiction is flagged for controlled review')
  })

  test('a failed provider payment never credits the wallet', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey: 'req-failed' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    assert.equal((await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'failed'))).status, 200)

    const after = await readPayment(created.paymentId)
    assert.equal(after?.status, 'failed')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.equal((await transactionsForUser(userId)).length, 0)
    assert.equal((await ledgerForUser(userId)).length, 0)
  })

  test('an expired payment is terminal and credits nothing', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey: 'req-expired' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    const expired = sandboxEvent({
      type: 'payment.expired',
      paymentId: payment.providerPaymentId,
      amountPaise: AMOUNT,
      reference: payment.providerReference ?? payment.providerPaymentId,
    })
    assert.equal((await deliverWebhook(expired)).status, 200)
    assert.equal((await readPayment(created.paymentId))?.status, 'expired')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
  })

  test('a provider-declined deposit (create call) fails without touching the wallet', { skip }, async () => {
    const { userId } = await createTestUser()
    // The simulated sandbox provider rejects amounts ending in .99 — a deterministic hook.
    const result = await createDepositPayment({ userId, amountPaise: 20_099, requestKey: 'req-decline' })
    assert.equal(result.status, 'failed')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.equal((await transactionsForUser(userId)).length, 0)
  })

  test('amount limits are enforced server-side', { skip }, async () => {
    const { userId } = await createTestUser()
    await assert.rejects(() => createDepositPayment({ userId, amountPaise: 9_999, requestKey: 'req-min' }), /DEPOSIT_BELOW_MINIMUM/)
    await assert.rejects(() => createDepositPayment({ userId, amountPaise: 20_000_001, requestKey: 'req-max' }), /DEPOSIT_ABOVE_MAXIMUM/)
    await assert.rejects(() => createDepositPayment({ userId, amountPaise: 15_000.5, requestKey: 'req-float' }), /PAYMENT_AMOUNT_INVALID/)
  })

  test('the same request key returns the same payment and creates one intent', { skip }, async () => {
    const { userId } = await createTestUser()
    const first = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey: 'req-idem' })
    const second = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey: 'req-idem' })
    assert.equal(second.paymentId, first.paymentId)
    const rows = await rawSql<{ count: string }>('select count(*)::text as count from payment_intent where user_id = $1', [userId])
    assert.equal(Number(rows[0].count), 1, 'one payment per request key')
  })
})

describe('Deposit webhook security (real PostgreSQL)', () => {
  async function pendingDeposit(requestKey: string) {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)
    return { userId, paymentId: created.paymentId, providerPaymentId: payment.providerPaymentId }
  }

  test('an invalid signature (wrong secret) is rejected and never credits', { skip }, async () => {
    const { userId, paymentId, providerPaymentId } = await pendingDeposit('sec-bad-secret')
    const event = sandboxEvent({
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      amountPaise: AMOUNT,
      secretOverride: 'not-the-real-secret',
    })
    const response = await deliverWebhook(event)
    assert.equal(response.status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.notEqual((await readPayment(paymentId))?.status, 'completed')
  })

  test('a missing signature is rejected', { skip }, async () => {
    const { userId, paymentId, providerPaymentId } = await pendingDeposit('sec-missing')
    const response = await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: AMOUNT, omitSignature: true }))
    assert.equal(response.status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.notEqual((await readPayment(paymentId))?.status, 'completed')
  })

  test('a malformed signature is rejected', { skip }, async () => {
    const { userId, providerPaymentId } = await pendingDeposit('sec-malformed')
    const response = await deliverWebhook(sandboxEvent({
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      amountPaise: AMOUNT,
      signatureHeaderOverride: 't=nope,v1=zzzz',
    }))
    assert.equal(response.status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
  })

  test('a stale signature timestamp is rejected (replay window)', { skip }, async () => {
    const { userId, providerPaymentId } = await pendingDeposit('sec-stale')
    const response = await deliverWebhook(sandboxEvent({
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      amountPaise: AMOUNT,
      timestampSeconds: Math.floor(Date.now() / 1000) - 3_600,
    }))
    assert.equal(response.status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
  })

  test('tampering with the body after signing is rejected', { skip }, async () => {
    const { userId, providerPaymentId } = await pendingDeposit('sec-tamper')
    const response = await deliverWebhook(sandboxEvent({
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      amountPaise: AMOUNT,
      // The signature is computed over the original bytes; the delivered body is different.
      tamperBodyAfterSigning: (body) => body.replace('"succeeded"', '"failed"'),
    }))
    assert.equal(response.status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
  })

  test('an unsigned body with no signature header at all is rejected', { skip }, async () => {
    const { userId, paymentId, providerPaymentId } = await pendingDeposit('sec-none')
    const response = await deliverWebhook({
      rawBody: JSON.stringify({ id: 'evt_forged', type: 'payment.succeeded', created: 1, data: { payment_id: providerPaymentId, status: 'succeeded', amount_paise: AMOUNT, currency: 'INR' } }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(response.status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.notEqual((await readPayment(paymentId))?.status, 'completed')
  })

  test('rejected deliveries are recorded for investigation', { skip }, async () => {
    const before = await rawSql<{ count: string }>("select count(*)::text as count from payment_webhook_event where status = 'rejected'")
    const { providerPaymentId } = await pendingDeposit('sec-record')
    await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: AMOUNT, secretOverride: 'wrong' }))
    const after = await rawSql<{ count: string }>("select count(*)::text as count from payment_webhook_event where status = 'rejected'")
    assert.equal(Number(after[0].count), Number(before[0].count) + 1)
  })

  test('an unknown provider is refused', { skip }, async () => {
    const response = await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: 'pi_nope', amountPaise: AMOUNT }), 'not-a-provider')
    assert.equal(response.status, 404)
    const empty = await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: 'pi_nope', amountPaise: AMOUNT }), '')
    assert.equal(empty.status, 400)
  })

  test('a validly signed event for an unknown payment changes nothing', { skip }, async () => {
    const response = await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: 'pi_unknown_123', amountPaise: AMOUNT }))
    assert.equal(response.status, 200)
    assert.equal(response.body.ignored, true)
    assert.equal(response.body.reason, 'PAYMENT_NOT_FOUND')
  })
})

describe('Deposit amount/currency integrity (real PostgreSQL)', () => {
  async function pendingDeposit(requestKey: string) {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: AMOUNT, requestKey })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)
    return { userId, paymentId: created.paymentId, providerPaymentId: payment.providerPaymentId, reference: payment.providerReference ?? payment.providerPaymentId }
  }

  test('a different provider amount is flagged and never credited', { skip }, async () => {
    const { userId, paymentId, providerPaymentId, reference } = await pendingDeposit('int-amount')
    const response = await deliverWebhook(sandboxEvent({
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      reference,
      amountPaise: AMOUNT + 100,
    }))
    assert.equal(response.status, 200)

    const payment = await readPayment(paymentId)
    assert.notEqual(payment?.status, 'completed', 'a mismatched amount must never settle')
    assert.equal(payment?.reconciliationStatus, 'mismatch')
    assert.equal(payment?.failureCode, 'PAYMENT_AMOUNT_MISMATCH')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.equal((await ledgerForUser(userId)).length, 0)
    const audits = await auditRowsFor(paymentId)
    assert.ok(audits.some((row) => row.action.includes('flag') || row.action.includes('payment')), 'a review flag is audited')
  })

  test('a different provider currency is flagged and never credited', { skip }, async () => {
    const { userId, paymentId, providerPaymentId, reference } = await pendingDeposit('int-currency')
    const response = await deliverWebhook(sandboxEvent({
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      reference,
      amountPaise: AMOUNT,
      currency: 'USD',
    }))
    assert.equal(response.status, 200)
    const payment = await readPayment(paymentId)
    assert.notEqual(payment?.status, 'completed')
    assert.equal(payment?.reconciliationStatus, 'mismatch')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
  })
})

after(async () => {
  await closePool()
})
