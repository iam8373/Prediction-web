import 'server-only'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { createDepositPayment, createWithdrawalPayment, refundTransaction, retryPayment } from '@/lib/payments/service'
import { runPaymentReconciliation, auditWalletAgainstLedger, listReconciliationFindings } from '@/lib/payments/reconciliation'
import { recheckStuckPayments } from '@/lib/payments/recheck'
import { RECHECK_POLICY } from '@/lib/payments/recheck-policy'
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
} from './harness.ts'
import { configureSandboxEnv, deliverWebhook, providerOutcomeWebhook, sandboxEvent, sandboxProvider } from './sandbox.ts'

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'
const DEPOSIT = 25_000
const UPI = 'refund@okaxis'

before(async () => {
  if (skip) return
  configureSandboxEnv()
  await resetDatabase()
})

/** A deposit that has really been credited, so refunds have something to reverse. */
async function settledDeposit(amount = DEPOSIT, requestKey = `refund-src-${Math.random()}`) {
  const { userId } = await createTestUser()
  const created = await createDepositPayment({ userId, amountPaise: amount, method: 'upi', requestKey })
  const payment = await readPayment(created.paymentId)
  assert.ok(payment?.providerPaymentId)
  assert.equal((await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'succeeded'))).status, 200)
  const settled = await readPayment(created.paymentId)
  assert.equal(settled?.status, 'completed')
  assert.ok(settled?.transactionId)
  return { userId, paymentId: created.paymentId, transactionId: settled.transactionId as string, providerPaymentId: payment.providerPaymentId }
}

async function findingsFor(paymentId: string) {
  return rawSql<{ status: string; internal_status: string; provider_status: string | null; notes: string | null }>(
    'select status, internal_status, provider_status, notes from payment_reconciliation_finding where payment_intent_id = $1 order by created_at desc',
    [paymentId],
  )
}

describe('Refund E2E against PostgreSQL', () => {
  test('an asynchronous refund waits for provider truth and then reverses the wallet once', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId, transactionId } = await settledDeposit()
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT)

    const refund = await refundTransaction({ adminUserId: adminId, transactionId, reason: 'customer request' })
    assert.equal(refund.status, 'pending', 'the provider has not confirmed the refund yet')
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT, 'no money moves before provider confirmation')

    const refundPayment = await readPayment(refund.transactionId)
    assert.ok(refundPayment?.providerPaymentId, 'the provider refund id is stored so its webhook can settle this refund')

    const response = await deliverWebhook(providerOutcomeWebhook(refundPayment.providerPaymentId, 'succeeded'))
    assert.equal(response.status, 200, 'the refund webhook must be matched to the refund it belongs to')

    const settledRefund = await readPayment(refund.transactionId)
    assert.equal(settledRefund?.status, 'completed')
    assert.equal(settledRefund?.refundStatus, 'full')

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), 0, 'the deposit is reversed exactly once')

    const transactions = await transactionsForUser(userId)
    const refunds = transactions.filter((row) => row.type === 'refund')
    assert.equal(refunds.length, 1, 'one refund transaction')
    assert.equal(Number(refunds[0].amountPaise), -DEPOSIT)
    assert.match(refunds[0].reference, /-REFUND$/)

    const ledger = await ledgerForUser(userId)
    assert.equal(ledger.filter((row) => row.type === 'refund').length, 1, 'one refund ledger movement')
    assert.equal(Number(ledger.filter((row) => row.type === 'refund')[0].amountPaise), -DEPOSIT)

    const parent = await readPayment(refundPayment.parentPaymentId as string)
    assert.equal(parent?.status, 'refunded')
    assert.ok((await notificationsForUser(userId)).some((row) => row.eventKey.includes('refund-settled')))
    assert.ok((await auditRowsFor(refund.transactionId)).some((row) => row.action === 'payment.refund.issued'))
  })

  test('requesting the same refund again cannot double-reverse the wallet', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId, transactionId } = await settledDeposit()
    const first = await refundTransaction({ adminUserId: adminId, transactionId })
    const refundPayment = await readPayment(first.transactionId)
    assert.ok(refundPayment?.providerPaymentId)
    await deliverWebhook(providerOutcomeWebhook(refundPayment.providerPaymentId, 'succeeded'))
    const afterFirst = await readWallet(userId)

    const second = await refundTransaction({ adminUserId: adminId, transactionId })
    assert.equal(second.transactionId, first.transactionId, 'the replay resolves to the same refund')

    const afterSecond = await readWallet(userId)
    assert.equal(Number(afterSecond.availablePaise), Number(afterFirst.availablePaise))
    assert.equal((await transactionsForUser(userId)).filter((row) => row.type === 'refund').length, 1)
    assert.equal((await ledgerForUser(userId)).filter((row) => row.type === 'refund').length, 1)
  })

  test('a transaction that is not refundable is refused', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId, transactionId } = await settledDeposit()
    const first = await refundTransaction({ adminUserId: adminId, transactionId })
    const refundPayment = await readPayment(first.transactionId)
    assert.ok(refundPayment?.providerPaymentId)
    await deliverWebhook(providerOutcomeWebhook(refundPayment.providerPaymentId, 'succeeded'))

    // The refund transaction itself is not refundable.
    const refundTransactionRow = (await transactionsForUser(userId)).find((row) => row.type === 'refund')
    assert.ok(refundTransactionRow)
    await assert.rejects(() => refundTransaction({ adminUserId: adminId, transactionId: refundTransactionRow.id }), /NOT_REFUNDABLE/)
  })

  test('a provider refund failure books no false credit and no refunded status', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId, transactionId, paymentId } = await settledDeposit()
    const before = await readWallet(userId)

    // Force the provider to report the original payment as unknown, which is the
    // real provider failure mode for a refund against a payment it cannot see.
    await rawSql('update payment_intent set provider_payment_id = null, provider_reference = null where id = $1', [paymentId])

    await assert.rejects(() => refundTransaction({ adminUserId: adminId, transactionId }), /REFUND_FAILED/)

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), Number(before.availablePaise), 'no wallet mutation on provider failure')
    assert.equal((await transactionsForUser(userId)).filter((row) => row.type === 'refund').length, 0, 'no refund transaction is booked')

    const refunds = await rawSql<{ id: string; status: string; parent_payment_id: string | null }>(
      "select id, status, parent_payment_id from payment_intent where direction = 'refund' and user_id = $1",
      [userId],
    )
    assert.deepEqual(refunds.map((row) => row.status), ['failed'], 'the refund is recorded as failed, never as refunded')
    assert.equal(refunds[0]?.parent_payment_id, paymentId, 'the failed refund still points at the payment it tried to reverse')
    assert.ok(
      (await auditRowsFor(refunds[0].id)).some((row) => row.action === 'payment.refund.failed'),
      'the provider failure is auditable',
    )
  })

  test('reversing a pending withdrawal returns the held funds without double-counting the ledger', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId } = await createTestUser({ availablePaise: 100_000 })
    const withdrawal = await createWithdrawalPayment({ userId, amountPaise: 70_000, destination: UPI, requestKey: 'refund-wdl' })
    const ledgerBefore = await ledgerForUser(userId)
    assert.equal(ledgerBefore.length, 1)
    assert.equal(ledgerBefore[0].status, 'pending')

    const withdrawalPayment = await readPayment(withdrawal.paymentId)
    assert.ok(withdrawalPayment?.transactionId)
    const refund = await refundTransaction({ adminUserId: adminId, transactionId: withdrawalPayment.transactionId })
    assert.equal(refund.status, 'pending', 'an async provider must confirm the reversal before money moves')
    const refundPayment = await readPayment(refund.transactionId)
    assert.ok(refundPayment?.providerPaymentId)
    assert.equal(
      (await deliverWebhook(providerOutcomeWebhook(refundPayment.providerPaymentId, 'succeeded'))).status,
      200,
    )

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), 100_000, 'the held funds are spendable again')
    assert.equal(Number(wallet.lockedPaise), 0)

    const ledger = await ledgerForUser(userId)
    assert.equal(ledger.length, 1, 'the hold is voided, not booked as a second credit')
    assert.equal(ledger[0].status, 'failed')
    assert.equal(Number(wallet.availablePaise) + Number(wallet.lockedPaise), 100_000)

    const parent = await readPayment(withdrawal.paymentId)
    assert.equal(parent?.status, 'cancelled')
  })

  test('partial refunds remain blocked', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { transactionId } = await settledDeposit()
    assert.equal(sandboxProvider().capabilities.partialRefunds, false, 'the product model does not allow partial reversals')
    const refund = await refundTransaction({ adminUserId: adminId, transactionId })
    const refundPayment = await readPayment(refund.transactionId)
    assert.equal(Number(refundPayment?.amountPaise), DEPOSIT, 'a refund always reverses the full original amount')
  })
})

describe('Admin retry from provider truth', () => {
  test('a stuck deposit is settled from the provider status lookup', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, requestKey: 'retry-stuck' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    // The provider settled it, but the webhook was lost.
    providerOutcomeWebhook(payment.providerPaymentId, 'succeeded')
    const result = await retryPayment({ adminUserId: adminId, paymentId: created.paymentId })
    assert.equal(result.handled, true)

    assert.equal((await readPayment(created.paymentId))?.status, 'completed')
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT)
    assert.equal((await ledgerForUser(userId)).length, 1, 'a retry settles through the same single writer')

    // Running it again is a no-op, not a second credit.
    await retryPayment({ adminUserId: adminId, paymentId: created.paymentId })
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT)
    assert.equal((await ledgerForUser(userId)).length, 1)
    assert.ok((await auditRowsFor(created.paymentId)).some((row) => row.action === 'payment.retry'))
  })
})

describe('Reconciliation E2E on real PostgreSQL data', () => {
  test('a settled deposit reconciles as matched and never mutates balances', { skip }, async () => {
    const { userId, paymentId } = await settledDeposit()
    const before = await readWallet(userId)

    const run = await runPaymentReconciliation({ limit: 100 })
    assert.equal(run.status, 'completed')
    assert.ok(run.checkedCount >= 1)

    const findings = await findingsFor(paymentId)
    assert.equal(findings[0]?.status, 'matched', 'internal and provider state agree')

    const intent = await readPayment(paymentId)
    assert.equal(intent?.status, 'completed', 'reconciliation is read-only: the payment keeps its state')
    assert.equal(intent?.reconciliationStatus, 'matched')
    const after = await readWallet(userId)
    assert.equal(Number(after.availablePaise), Number(before.availablePaise), 'reconciliation never adjusts a balance')
    assert.equal(Number(after.lockedPaise), Number(before.lockedPaise))
  })

  test('an amount divergence is reported, never "fixed"', { skip }, async () => {
    const { userId, paymentId } = await settledDeposit()
    // Corrupt the internal record exactly the way a bad write would.
    await rawSql('update payment_intent set amount_paise = amount_paise + 500 where id = $1', [paymentId])
    const before = await readWallet(userId)

    await runPaymentReconciliation({ limit: 100 })
    const findings = await findingsFor(paymentId)
    assert.equal(findings[0]?.status, 'amount_mismatch')
    assert.match(String(findings[0]?.notes), /provider reported/)

    const intent = await readPayment(paymentId)
    assert.equal(intent?.status, 'completed')
    assert.equal(intent?.reconciliationStatus, 'amount_mismatch')
    const after = await readWallet(userId)
    assert.equal(Number(after.availablePaise), Number(before.availablePaise), 'no arbitrary balance adjustment')
  })

  test('a currency divergence is reported', { skip }, async () => {
    const { paymentId } = await settledDeposit()
    await rawSql("update payment_intent set currency = 'USD' where id = $1", [paymentId])
    await runPaymentReconciliation({ limit: 100 })
    const findings = await findingsFor(paymentId)
    assert.equal(findings[0]?.status, 'currency_mismatch')
  })

  test('a payment the provider does not know about is reported', { skip }, async () => {
    const { paymentId } = await settledDeposit()
    await rawSql("update payment_intent set provider_payment_id = 'pi_absent_from_provider' where id = $1", [paymentId])
    await runPaymentReconciliation({ limit: 100 })
    const findings = await findingsFor(paymentId)
    assert.equal(findings[0]?.status, 'missing_provider_record')
  })

  test('a provider record with no internal counterpart is reported', { skip }, async () => {
    await settledDeposit()
    // A payment that exists only at the provider: exactly what "missing internal record" detects.
    const orphan = await sandboxProvider().createDeposit({
      amountPaise: 12_345,
      currency: 'INR',
      idempotencyKey: `orphan:${Math.random()}`,
    })

    const run = await runPaymentReconciliation({ limit: 100 })
    assert.equal(run.status, 'completed')
    const orphanFindings = await rawSql<{ status: string; notes: string | null }>(
      'select status, notes from payment_reconciliation_finding where payment_intent_id = $1',
      [`provider:${orphan.id}`],
    )
    assert.equal(orphanFindings[0]?.status, 'missing_internal_record')
  })

  test('repeated reconciliation is stable and re-runnable', { skip }, async () => {
    const { paymentId } = await settledDeposit()
    const first = await runPaymentReconciliation({ limit: 100 })
    const second = await runPaymentReconciliation({ limit: 100 })
    assert.notEqual(first.id, second.id)
    assert.equal(second.status, 'completed')
    const findings = await findingsFor(paymentId)
    assert.ok(findings.length >= 2, 'one finding per run, keyed by (run, payment)')
  })

  test('the reconciliation view returns findings without matched noise by default', { skip }, async () => {
    const { paymentId } = await settledDeposit()
    await rawSql('update payment_intent set amount_paise = amount_paise + 1 where id = $1', [paymentId])
    await runPaymentReconciliation({ limit: 100 })
    const reviewable = await listReconciliationFindings({ limit: 100 })
    assert.ok(reviewable.length >= 1)
    assert.ok(reviewable.every((finding) => finding.status !== 'matched'))
    const all = await listReconciliationFindings({ includeMatched: true, limit: 200 })
    assert.ok(all.some((finding) => finding.status === 'matched'))
  })

  test('an admin reconciliation run is audited', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    await settledDeposit()
    const run = await runPaymentReconciliation({ actorUserId: adminId, limit: 100 })
    const audits = await rawSql<{ action: string; actor_role: string }>('select action, actor_role from audit_log where entity_id = $1', [run.id])
    assert.equal(audits[0]?.action, 'payment.reconciliation.run')
    assert.equal(audits[0]?.actor_role, 'admin')
  })
})

describe('Bounded provider re-check (real PostgreSQL)', () => {
  test('a payment still open at the provider is re-checked politely and stays pending', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, requestKey: 'recheck-open' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)
    // Age the payment past the minimum age so the policy considers it due.
    await rawSql('update payment_intent set created_at = $2, updated_at = $2 where id = $1', [created.paymentId, Date.now() - RECHECK_POLICY.minAgeMs - 60_000])

    const summary = await recheckStuckPayments({ limit: 10 })
    assert.equal(summary.checked >= 1, true)
    assert.equal(summary.stillPending >= 1, true)
    const after = await readPayment(created.paymentId)
    assert.equal(after?.status, 'pending', 'a provider that has not decided keeps the payment pending')
    assert.equal(after?.recheckAttempts, 1)
    assert.ok(after?.lastRecheckedAt)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0, 'a re-check never credits anything on its own')
  })

  test('the re-check budget is bounded and exhaustion flags the payment', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, requestKey: 'recheck-exhaust' })
    await rawSql(
      "update payment_intent set provider_payment_id = 'pi_missing_forever', recheck_attempts = $2, created_at = $3, updated_at = $3 where id = $1",
      // Old enough that the final backoff step has elapsed, so the next lookup
      // exhausts the budget.
      [created.paymentId, RECHECK_POLICY.maxAttempts - 1, Date.now() - 73 * 3_600_000],
    )

    const summary = await recheckStuckPayments({ limit: 10 })
    assert.equal(summary.flagged >= 1, true)

    const after = await readPayment(created.paymentId)
    assert.equal(after?.status, 'pending', 'the payment is not failed or credited on a guess')
    assert.equal(after?.recheckAttempts, RECHECK_POLICY.maxAttempts)
    assert.equal(after?.reconciliationStatus, 'mismatch')
    assert.equal(after?.failureCode, 'PROVIDER_RECORD_MISSING')
    assert.ok((await auditRowsFor(created.paymentId)).some((row) => row.action === 'payment.review.flagged'))

    // Exhausted payments are no longer candidates.
    const second = await recheckStuckPayments({ limit: 10 })
    assert.equal(second.outcomes.some((outcome) => outcome.paymentId === created.paymentId), false)
  })

  test('a re-check that finds provider success settles the payment', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, requestKey: 'recheck-settle' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    // The provider really settles, but no webhook ever reaches us.
    sandboxProvider().buildOutcomeWebhook({ paymentId: payment.providerPaymentId, outcome: 'succeeded' })
    await rawSql('update payment_intent set created_at = $2, updated_at = $2 where id = $1', [created.paymentId, Date.now() - RECHECK_POLICY.minAgeMs - 60_000])

    const summary = await recheckStuckPayments({ limit: 10 })
    assert.equal(summary.settled >= 1, true)
    const after = await readPayment(created.paymentId)
    assert.equal(after?.status, 'completed')
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT)
    assert.equal((await ledgerForUser(userId)).length, 1, 'a re-check settles through the same single-writer path')
  })
})

describe('Account-level accounting consistency', () => {
  test('wallet matches the ledger after deposits, a withdrawal and a refund', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId } = await createTestUser({ availablePaise: 0 })

    // Two deposits.
    for (const amount of [DEPOSIT, 30_000]) {
      const created = await createDepositPayment({ userId, amountPaise: amount, requestKey: `audit-${amount}` })
      const payment = await readPayment(created.paymentId)
      assert.ok(payment?.providerPaymentId)
      assert.equal((await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'succeeded'))).status, 200)
    }
    // A withdrawal that the provider confirms.
    const withdrawal = await createWithdrawalPayment({ userId, amountPaise: 30_000, destination: UPI, requestKey: 'audit-wdl' })
    const withdrawalPayment = await readPayment(withdrawal.paymentId)
    assert.ok(withdrawalPayment?.providerPaymentId)
    assert.equal((await deliverWebhook(providerOutcomeWebhook(withdrawalPayment.providerPaymentId, 'succeeded'))).status, 200)
    // A withdrawal that fails and releases.
    const failing = await createWithdrawalPayment({ userId, amountPaise: 25_000, destination: UPI, requestKey: 'audit-wdl-fail' })
    const failingPayment = await readPayment(failing.paymentId)
    assert.ok(failingPayment?.providerPaymentId)
    assert.equal((await deliverWebhook(providerOutcomeWebhook(failingPayment.providerPaymentId, 'failed'))).status, 200)

    const wallet = await readWallet(userId)
    const ledger = await ledgerForUser(userId)
    const audit = await auditWalletAgainstLedger(userId)
    assert.equal(audit.status, 'matched', audit.differencePaise === 0 ? '' : `difference ${audit.differencePaise}`)
    assert.equal(audit.differencePaise, 0)
    assert.equal(
      Number(wallet.availablePaise),
      DEPOSIT + 30_000 - 30_000,
      'opening + deposits + settlements - completed withdrawals',
    )
    assert.equal(Number(wallet.lockedPaise), 0)
    assert.ok(ledger.length >= 4)

    // Reverse one deposit and confirm the books still balance.
    const depositTransaction = (await transactionsForUser(userId)).find((row) => row.type === 'deposit')
    assert.ok(depositTransaction)
    const refund = await refundTransaction({ adminUserId: adminId, transactionId: depositTransaction.id, reason: 'accounting check' })
    const refundPayment = await readPayment(refund.transactionId)
    assert.ok(refundPayment?.providerPaymentId)
    await deliverWebhook(providerOutcomeWebhook(refundPayment.providerPaymentId, 'succeeded'))

    const afterRefund = await auditWalletAgainstLedger(userId)
    assert.equal(afterRefund.differencePaise, 0, 'the ledger and the wallet agree after a refund')
    assert.equal(afterRefund.status, 'matched')
  })

  test('a failed match is reported, not compensated', { skip }, async () => {
    const { userId } = await settledDeposit()
    // Simulate an unexplained balance: money in the wallet with no ledger entry.
    await rawSql('update wallet set available_paise = available_paise + 777 where user_id = $1', [userId])
    const audit = await auditWalletAgainstLedger(userId)
    assert.equal(audit.status, 'difference')
    assert.equal(audit.differencePaise, 777)
    // The audit is read-only — it does not "fix" the balance.
    assert.equal(audit.walletAvailablePaise, Number((await readWallet(userId)).availablePaise))
  })
})

after(async () => {
  await closePool()
})
