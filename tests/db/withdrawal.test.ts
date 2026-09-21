import 'server-only'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { createWithdrawalPayment, resolveWithdrawal } from '@/lib/payments/service'
import {
  auditRowsFor,
  closePool,
  createTestUser,
  databaseUrl,
  ledgerForUser,
  rawSql,
  readPayment,
  readWallet,
  resetDatabase,
  transactionsForUser,
  webhookEventsFor,
} from './harness.ts'
import { configureSandboxEnv, deliverWebhook, providerOutcomeWebhook, sandboxEvent } from './sandbox.ts'

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'
const START = 100_000 // ₹1,000
const OUT = 70_000 // ₹700
const UPI = 'trader@okhdfcbank'

before(async () => {
  if (skip) return
  configureSandboxEnv()
  await resetDatabase()
})

async function fundedUser(amount = START) {
  const user = await createTestUser({ availablePaise: amount })
  return user
}

describe('Withdrawal E2E against PostgreSQL', () => {
  test('reserves funds, then settles the locked balance on provider success', { skip }, async () => {
    const { userId } = await fundedUser()
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-happy' })

    assert.equal(result.status, 'pending', 'the create call must not finalise a payout')
    assert.equal(result.settledImmediately, false)

    // Reservation: funds left the spendable balance and are held, not spent.
    const reserved = await readWallet(userId)
    assert.equal(Number(reserved.availablePaise), START - OUT)
    assert.equal(Number(reserved.lockedPaise), OUT)

    const payment = await readPayment(result.paymentId)
    assert.ok(payment?.providerPaymentId)
    assert.ok(payment?.providerIdempotencyKey, 'a payout idempotency key is stored for safe retries')
    assert.equal(payment?.direction, 'withdrawal')
    assert.equal(Number(payment?.amountPaise), OUT)

    const pendingTxns = await transactionsForUser(userId)
    assert.equal(pendingTxns.length, 1)
    assert.equal(pendingTxns[0].status, 'pending')
    assert.equal(Number(pendingTxns[0].amountPaise), -OUT)
    const pendingLedger = await ledgerForUser(userId)
    assert.equal(pendingLedger.length, 1)
    assert.equal(pendingLedger[0].status, 'pending')

    // Provider confirms the payout.
    const response = await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'succeeded'))
    assert.equal(response.status, 200)

    const settled = await readPayment(result.paymentId)
    assert.equal(settled?.status, 'completed')
    assert.ok(settled?.settledAt)

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.lockedPaise), 0, 'a settled payout releases the hold')
    assert.equal(Number(wallet.availablePaise), START - OUT, 'the money leaves the account exactly once')

    const transactions = await transactionsForUser(userId)
    assert.equal(transactions.length, 1)
    assert.equal(transactions[0].status, 'completed')
    const ledger = await ledgerForUser(userId)
    assert.equal(ledger.length, 1, 'one ledger movement per withdrawal')
    assert.equal(ledger[0].status, 'completed')
    assert.equal(Number(ledger[0].amountPaise), -OUT)

    const webhooks = await webhookEventsFor(result.paymentId)
    assert.equal(webhooks.length, 1)
    assert.equal(webhooks[0].status, 'processed')
    assert.ok((await auditRowsFor(result.paymentId)).length >= 1)
  })

  test('a failed payout releases the reservation and loses no money', { skip }, async () => {
    const { userId } = await fundedUser()
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-fail' })
    const payment = await readPayment(result.paymentId)
    assert.ok(payment?.providerPaymentId)

    assert.equal((await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'failed'))).status, 200)

    const after = await readPayment(result.paymentId)
    assert.equal(after?.status, 'failed')

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), START, 'the reserved funds are back and spendable')
    assert.equal(Number(wallet.lockedPaise), 0)

    const transactions = await transactionsForUser(userId)
    assert.equal(transactions.length, 1)
    assert.equal(transactions[0].status, 'failed')
    const ledger = await ledgerForUser(userId)
    assert.equal(ledger.length, 1, 'exactly one ledger movement for the failed withdrawal')
    assert.equal(ledger[0].status, 'failed')
    assert.equal(Number(wallet.availablePaise) + Number(wallet.lockedPaise), START)
  })

  test('a duplicate failure webhook cannot move the wallet again', { skip }, async () => {
    const { userId } = await fundedUser()
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-dupfail' })
    const payment = await readPayment(result.paymentId)
    assert.ok(payment?.providerPaymentId)

    const event = providerOutcomeWebhook(payment.providerPaymentId, 'failed')
    assert.equal((await deliverWebhook(event)).status, 200)
    const first = await readWallet(userId)
    const second = await deliverWebhook(event)
    assert.equal(second.status, 200)
    assert.equal(second.body.duplicate, true)

    const after = await readWallet(userId)
    assert.equal(Number(after.availablePaise), Number(first.availablePaise))
    assert.equal(Number(after.lockedPaise), 0)
    assert.equal((await ledgerForUser(userId)).length, 1)
  })

  test('a late failure event cannot reverse a settled payout', { skip }, async () => {
    const { userId } = await fundedUser()
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-late' })
    const payment = await readPayment(result.paymentId)
    assert.ok(payment?.providerPaymentId)

    assert.equal((await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'succeeded'))).status, 200)
    const settledWallet = await readWallet(userId)

    const late = sandboxEvent({ type: 'payout.failed', paymentId: payment.providerPaymentId, amountPaise: OUT, reference: payment.providerReference ?? payment.providerPaymentId })
    assert.equal((await deliverWebhook(late)).status, 200)

    const after = await readPayment(result.paymentId)
    assert.equal(after?.status, 'completed', 'a settled payout is never silently reverted')
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), Number(settledWallet.availablePaise))
    assert.equal(Number(wallet.lockedPaise), 0)
    assert.equal(after?.reconciliationStatus, 'mismatch', 'the contradiction is flagged for review')
  })

  test('the create call is never treated as final and provider truth gates completion', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: START })
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-not-final' })
    const payment = await readPayment(result.paymentId)
    assert.ok(payment?.providerPaymentId)

    // The provider has not reported the payout as processed, so an admin cannot
    // complete it even though the create request itself was accepted.
    await assert.rejects(
      () => resolveWithdrawal({ adminUserId: adminId, paymentId: result.paymentId, action: 'complete' }),
      /PROVIDER_NOT_SETTLED/,
    )
    const held = await readWallet(userId)
    assert.equal(Number(held.lockedPaise), OUT, 'the funds stay reserved while the payout is unconfirmed')
    assert.equal(Number(held.availablePaise), START - OUT)
    assert.equal((await readPayment(result.paymentId))?.status, 'pending')

    // Only provider truth (webhook, or a status lookup reporting processed) settles it.
    assert.equal((await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'succeeded'))).status, 200)
    assert.equal((await readPayment(result.paymentId))?.status, 'completed')
    assert.equal(Number((await readWallet(userId)).lockedPaise), 0)
  })

  test('an event for an unrelated payout cannot move this account', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: START })
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-unrelated' })

    const unrelated = sandboxEvent({ type: 'payout.failed', paymentId: 'po_unrelated_999', amountPaise: OUT })
    const response = await deliverWebhook(unrelated)
    assert.equal(response.status, 200)
    assert.equal(response.body.ignored, true)
    assert.equal(response.body.reason, 'PAYMENT_NOT_FOUND')

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.lockedPaise), OUT)
    assert.equal(Number(wallet.availablePaise), START - OUT)
    assert.equal((await readPayment(result.paymentId))?.status, 'pending')
  })

  test('insufficient balance is refused before any provider call', { skip }, async () => {
    const { userId } = await fundedUser(50_000)
    await assert.rejects(
      () => createWithdrawalPayment({ userId, amountPaise: 60_000, destination: UPI, requestKey: 'wdl-poor' }),
      /INSUFFICIENT_BALANCE/,
    )
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), 50_000)
    assert.equal(Number(wallet.lockedPaise), 0)
    assert.equal((await transactionsForUser(userId)).length, 0)
    assert.equal((await rawSql('select 1 from payment_intent where user_id = $1', [userId])).length, 0)
  })

  test('withdrawal limits are enforced server-side', { skip }, async () => {
    const { userId } = await fundedUser(1_000_000)
    await assert.rejects(() => createWithdrawalPayment({ userId, amountPaise: 19_999, destination: UPI, requestKey: 'wdl-min' }), /WITHDRAWAL_BELOW_MINIMUM/)
    await assert.rejects(() => createWithdrawalPayment({ userId, amountPaise: 20_000_001, destination: UPI, requestKey: 'wdl-max' }), /WITHDRAWAL_ABOVE_MAXIMUM/)
  })

  test('the same request key reserves funds once', { skip }, async () => {
    const { userId } = await fundedUser()
    const first = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-idem' })
    const second = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-idem' })
    assert.equal(second.paymentId, first.paymentId)
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.lockedPaise), OUT, 'a replayed request must not reserve twice')
    assert.equal(Number(wallet.availablePaise), START - OUT)
    assert.equal((await ledgerForUser(userId)).length, 1)
  })

  test('an admin completes a withdrawal only against settled provider truth, and it is audited', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: START })
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-admin-complete' })
    const payment = await readPayment(result.paymentId)
    assert.ok(payment?.providerPaymentId)

    // The provider really settles, but the webhook never arrives: the admin
    // completes it from provider truth.
    providerOutcomeWebhook(payment.providerPaymentId, 'succeeded')
    const resolution = await resolveWithdrawal({ adminUserId: adminId, paymentId: result.paymentId, action: 'complete' })
    assert.equal(resolution.status, 'completed')

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.lockedPaise), 0)
    assert.equal(Number(wallet.availablePaise), START - OUT)
    assert.equal((await ledgerForUser(userId))[0].status, 'completed')
    assert.ok((await rawSql<{ action: string }>('select action from audit_log where entity_id = $1', [result.paymentId]))
      .some((row) => row.action === 'payment.withdrawal.completed'))

    // Completing it again cannot move money a second time.
    await assert.rejects(() => resolveWithdrawal({ adminUserId: adminId, paymentId: result.paymentId, action: 'complete' }), /PAYMENT_ALREADY_FINAL/)
    assert.equal(Number((await readWallet(userId)).availablePaise), START - OUT)
  })

  test('an admin can release a pending withdrawal and the funds return', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: START, isAdmin: true })
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-admin' })

    const resolution = await resolveWithdrawal({ adminUserId: adminId, paymentId: result.paymentId, action: 'fail', reason: 'payout rail outage' })
    assert.equal(resolution.status, 'failed')
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), START)
    assert.equal(Number(wallet.lockedPaise), 0)
    const audits = await rawSql<{ action: string }>('select action from audit_log where entity_id = $1', [result.paymentId])
    assert.ok(audits.some((row) => row.action === 'payment.withdrawal.failed'))
  })
})

describe('Withdrawal concurrency (real PostgreSQL)', () => {
  test('two simultaneous withdrawals of ₹800 on a ₹1,000 balance: only one is reserved', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: START })
    const amount = 80_000

    const results = await Promise.allSettled([
      createWithdrawalPayment({ userId, amountPaise: amount, destination: UPI, requestKey: 'race-a' }),
      createWithdrawalPayment({ userId, amountPaise: amount, destination: UPI, requestKey: 'race-b' }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.equal(fulfilled.length, 1, 'the database must refuse the second reservation')
    assert.equal(rejected.length, 1)
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /INSUFFICIENT_BALANCE/)

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), START - amount, 'available balance is never negative')
    assert.equal(Number(wallet.lockedPaise), amount, 'locked balance never exceeds the money that actually exists')
    assert.equal(Number(wallet.availablePaise) + Number(wallet.lockedPaise), START, 'no money is created or lost')

    const intents = await rawSql<{ count: string }>('select count(*)::text as count from payment_intent where user_id = $1', [userId])
    assert.equal(Number(intents[0].count), 1, 'only one withdrawal intent exists')
    assert.equal((await ledgerForUser(userId)).length, 1)
  })

  test('three simultaneous ₹400 withdrawals on ₹1,000: exactly two are reserved', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: START })
    const amount = 40_000

    const results = await Promise.allSettled(
      ['r1', 'r2', 'r3'].map((key) => createWithdrawalPayment({ userId, amountPaise: amount, destination: UPI, requestKey: `race-${key}` })),
    )

    const fulfilled = results.filter((result) => result.status === 'fulfilled').length
    assert.equal(fulfilled, 2)
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), START - 2 * amount)
    assert.equal(Number(wallet.lockedPaise), 2 * amount)
    assert.equal(Number(wallet.availablePaise) >= 0, true)
    const intents = await rawSql<{ count: string }>('select count(*)::text as count from payment_intent where user_id = $1', [userId])
    assert.equal(Number(intents[0].count), 2)
  })

  test('simultaneous identical requests reserve once', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: START })
    const results = await Promise.allSettled([
      createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'race-same' }),
      createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'race-same' }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{ paymentId: string }>[]
    assert.equal(fulfilled.length, 2, 'a concurrent replay resolves to the same payment rather than failing')
    assert.equal(fulfilled[0].value.paymentId, fulfilled[1].value.paymentId)
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.lockedPaise), OUT, 'the money is reserved exactly once')
    assert.equal((await ledgerForUser(userId)).length, 1)
  })

  test('a settled payout cannot be settled twice by concurrent webhooks', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: START })
    const result = await createWithdrawalPayment({ userId, amountPaise: OUT, destination: UPI, requestKey: 'wdl-race-settle' })
    const payment = await readPayment(result.paymentId)
    assert.ok(payment?.providerPaymentId)

    const success = sandboxEvent({
      type: 'payout.succeeded',
      paymentId: payment.providerPaymentId,
      amountPaise: OUT,
      reference: payment.providerReference ?? payment.providerPaymentId,
    })
    const [a, b] = await Promise.all([deliverWebhook(success), deliverWebhook(success)])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.lockedPaise), 0)
    assert.equal(Number(wallet.availablePaise), START - OUT)
    assert.equal((await ledgerForUser(userId)).length, 1)
    assert.equal((await transactionsForUser(userId)).length, 1)
  })
})

after(async () => {
  await closePool()
})
