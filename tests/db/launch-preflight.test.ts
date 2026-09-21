import 'server-only'

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { getPaymentConfig } from '@/lib/payments/config'
import { createDepositPayment, createWithdrawalPayment } from '@/lib/payments/service'
import { auditAccountingIntegrity, auditWalletAgainstLedger } from '@/lib/payments/reconciliation'
import {
  closePool,
  createTestUser,
  databaseUrl,
  paymentRowsForUser,
  rawSql,
  readPayment,
  readWallet,
  resetDatabase,
  setWallet,
} from './harness.ts'
import { configureSandboxEnv, deliverWebhook, providerOutcomeWebhook } from './sandbox.ts'

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'
const DEPOSIT = 25_000

/** The environment this process started with, restored after each policy test. */
const originalNodeEnv = process.env.NODE_ENV

before(async () => {
  if (skip) return
  configureSandboxEnv()
})

after(async () => {
  if (skip) return
  restoreNodeEnv()
  await closePool()
})

/** `process.env.NODE_ENV` is typed read-only; the runtime allows it. */
function setNodeEnv(value: string | undefined) {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

function restoreNodeEnv() {
  setNodeEnv(originalNodeEnv)
}

/**
 * Launch-gate behaviour.
 *
 * Everything here runs against a real PostgreSQL and drives the application's own
 * services, so the assertions are about actual rows, not about mocks. The
 * accounting sweep is a whole-database invariant, so the suite resets the schema
 * before every test: a fixture left behind by one test must never be mistaken for
 * a drift detected by the next.
 */
describe('Launch gate: accounting invariants', () => {
  beforeEach(async () => {
    if (skip) return
    configureSandboxEnv()
    restoreNodeEnv()
    await resetDatabase()
  })

  test('is clean after money moved through the real webhook path', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'preflight-clean' })
    const payment = await readPayment(created.paymentId)
    assert.ok(payment?.providerPaymentId)

    const delivery = await deliverWebhook(providerOutcomeWebhook(payment.providerPaymentId, 'succeeded'))
    assert.equal(delivery.status, 200)
    assert.equal((await readPayment(created.paymentId))?.status, 'completed')
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT)

    const audit = await auditAccountingIntegrity()
    assert.equal(audit.status, 'clean')
    assert.equal(audit.walletDifferenceCount, 0)
    assert.equal(audit.counts.settledPaymentsWithoutTransaction, 0)
    assert.equal(audit.counts.completedTransactionsWithoutLedger, 0)
    assert.equal(audit.counts.refundPaymentsWithoutParent, 0)
    assert.equal(audit.counts.awaitingSettlement, 0)
    assert.ok(audit.checked.includes('wallet_ledger_equation'))
    assert.deepEqual(audit.notChecked, [])
  })

  test('detects a balance that accounting never booked', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: 100_000 })

    const audit = await auditAccountingIntegrity()
    assert.equal(audit.status, 'findings')
    assert.equal(audit.walletDifferenceCount, 1)
    assert.equal(audit.walletDifferenceSplit.unexplainedAccounts, 1)
    assert.equal(audit.walletDifferenceSplit.shortfallAccounts, 0)
    assert.equal(audit.walletDifferences[0]?.userId, userId)
    assert.equal(audit.walletDifferences[0]?.walletDifferencePaise, 100_000)
    // Nothing was ever booked for this account, which is what tells an operator
    // "seed data" apart from "a posting drifted".
    assert.equal(audit.walletDifferences[0]?.ledgerEntryCount, 0)

    // The set-based sweep and the per-account audit must agree; this is the guard
    // against the two invariant definitions silently diverging.
    assert.equal((await auditWalletAgainstLedger(userId)).status, 'difference')
  })

  test('agrees with the per-account audit when the ledger does balance', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'preflight-agree' })
    const payment = await readPayment(created.paymentId)
    await deliverWebhook(providerOutcomeWebhook(payment?.providerPaymentId as string, 'succeeded'))

    const perAccount = await auditWalletAgainstLedger(userId)
    const sweep = await auditAccountingIntegrity()
    assert.equal(perAccount.status, 'matched')
    assert.equal(sweep.walletDifferenceCount, 0)
    assert.equal(sweep.status, 'clean')
  })

  test('detects a negative balance', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: 5_000 })
    await setWallet(userId, { availablePaise: -1, lockedPaise: 0 })

    const audit = await auditAccountingIntegrity()
    assert.equal(audit.status, 'findings')
    assert.equal(audit.walletDifferenceCount, 1)
    assert.equal(audit.walletDifferenceSplit.shortfallAccounts, 1)
    assert.equal(audit.walletDifferences[0]?.userId, userId)
  })

  test('detects a settled payment that lost its transaction link', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'preflight-link' })
    const payment = await readPayment(created.paymentId)
    await deliverWebhook(providerOutcomeWebhook(payment?.providerPaymentId as string, 'succeeded'))

    // Simulates the corruption the check exists for: money settled with nothing
    // pointing at the transaction that recorded it.
    await rawSql('update payment_intent set transaction_id = null where id = $1', [created.paymentId])

    const audit = await auditAccountingIntegrity()
    assert.equal(audit.counts.settledPaymentsWithoutTransaction, 1)
    assert.equal(audit.status, 'findings')
  })

  test('detects a completed transaction with no ledger entry', { skip }, async () => {
    const { userId } = await createTestUser()
    await rawSql(
      `insert into "transaction" (id, user_id, reference, type, amount_paise, status, description, created_at)
       values ($1, $2, $3, 'deposit', 1000, 'completed', 'orphan', $4)`,
      [`txn_orphan_${process.pid}`, userId, `ORPHAN-${process.pid}`, Date.now()],
    )

    const audit = await auditAccountingIntegrity()
    assert.equal(audit.counts.completedTransactionsWithoutLedger, 1)
    assert.equal(audit.status, 'findings')
  })

  test('counts a payment the provider confirmed but that never settled', { skip }, async () => {
    const { userId } = await createTestUser()
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'preflight-verified' })
    const payment = await readPayment(created.paymentId)

    // A delivery that is signed but does not exist as a payable event leaves the
    // payment in `verified` — recoverable, and reported separately from a drift.
    await rawSql("update payment_intent set status = 'verified' where id = $1", [created.paymentId])
    assert.ok(payment?.providerPaymentId)

    const audit = await auditAccountingIntegrity()
    // `verified` is not counted as settled-without-transaction, but it is visible.
    assert.equal(audit.counts.awaitingSettlement, 1)
  })
})

describe('Launch gate: production payment posture', () => {
  beforeEach(async () => {
    if (skip) return
    configureSandboxEnv()
    await resetDatabase()
  })

  test('a production deployment that cannot honour live money refuses deposits', { skip }, async () => {
    const { userId } = await createTestUser()
    setNodeEnv('production')
    process.env.PAYMENTS_MODE = 'live'
    delete process.env.PAYMENTS_LIVE_ACTIVATION

    const config = getPaymentConfig()
    assert.equal(config.requested, 'live')
    assert.equal(config.productionStrict, true)
    assert.equal(config.mutationBlocked, true)
    assert.equal(config.liveEnabled, false)

    await assert.rejects(
      () => createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'posture-deposit' }),
      /PAYMENTS_CONFIG_DEGRADED/,
    )

    // Nothing was written and no money appeared.
    assert.equal((await paymentRowsForUser(userId)).length, 0)
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), 0)
    assert.equal(Number(wallet.lockedPaise), 0)

    restoreNodeEnv()
  })

  test('a production deployment that cannot honour withdrawals never locks funds', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: 50_000 })
    setNodeEnv('production')
    process.env.PAYMENTS_MODE = 'live'
    delete process.env.PAYMENTS_LIVE_ACTIVATION

    await assert.rejects(
      () =>
        createWithdrawalPayment({
          userId,
          amountPaise: 20_000,
          destination: 'trader@okaxis',
          requestKey: 'posture-withdraw',
        }),
      /PAYMENTS_CONFIG_DEGRADED/,
    )

    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), 50_000)
    assert.equal(Number(wallet.lockedPaise), 0)
    assert.equal((await paymentRowsForUser(userId)).length, 0)

    restoreNodeEnv()
  })

  test('a production simulator is refused unless the operator acknowledges it', { skip }, async () => {
    const { userId } = await createTestUser()
    setNodeEnv('production')
    process.env.PAYMENTS_MODE = 'sandbox'
    process.env.PAYMENTS_SANDBOX_PROVIDER = 'simulated'
    process.env.PAYMENTS_WEBHOOK_SECRET_SANDBOX = 'predik-test-sandbox-webhook-secret'
    delete process.env.PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION

    assert.equal(getPaymentConfig().mutationBlocked, true)
    await assert.rejects(
      () => createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'posture-sim' }),
      /PAYMENTS_CONFIG_DEGRADED/,
    )
    assert.equal((await paymentRowsForUser(userId)).length, 0)

    // The explicit acknowledgement is what keeps a deliberate simulated
    // deployment (preview/demo) working — the gate is not a blanket outage.
    process.env.PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION = 'true'
    assert.equal(getPaymentConfig().mutationBlocked, false)
    const created = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'posture-sim-ack' })
    assert.ok(created.paymentId)

    delete process.env.PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION
    restoreNodeEnv()
  })
})

describe('Launch gate: health endpoint', () => {
  beforeEach(async () => {
    if (skip) return
    configureSandboxEnv()
    restoreNodeEnv()
    await resetDatabase()
  })

  test('reports application and database health without disclosing configuration', { skip }, async () => {
    const { GET } = await import('@/app/api/health/route')
    const response = await GET()
    assert.equal(response.status, 200)

    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.ok, true)
    assert.equal((body.checks as Record<string, string>).application, 'ok')
    assert.equal((body.checks as Record<string, string>).database, 'ok')
    assert.equal((body.database as Record<string, unknown>).reachable, true)
    assert.equal((body.database as Record<string, unknown>).schemaReady, true)

    // A health endpoint must never become an information-disclosure endpoint.
    const serialized = JSON.stringify(body)
    for (const forbidden of ['DATABASE_URL', 'postgres://', 'postgresql://', 'SECRET', 'password', 'PAYMENTS_RAZORPAY_LIVE']) {
      assert.ok(!serialized.includes(forbidden), `health response leaked "${forbidden}"`)
    }
  })

  test('says nothing about the payment posture to an unauthenticated caller', { skip }, async () => {
    // The endpoint is public, so describing the payment mode — or whether the
    // deployment is refusing to move money — hands deployment configuration to
    // anyone who asks. Operators read that from `pnpm preflight` or the admin
    // screens, which require a session.
    setNodeEnv('production')
    process.env.PAYMENTS_MODE = 'live'
    delete process.env.PAYMENTS_LIVE_ACTIVATION
    delete process.env.PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION

    const { GET } = await import('@/app/api/health/route')
    const response = await GET()
    const body = (await response.json()) as Record<string, unknown>

    assert.equal(response.status, 200, 'the process and database are healthy')
    assert.equal('payments' in body, false, 'the response must not carry the payment posture')
    assert.ok(!JSON.stringify(body).includes('live'), 'the configured payment mode must not be disclosed')

    // The posture itself is still enforced and still discoverable internally.
    assert.equal(getPaymentConfig().mutationBlocked, true)

    delete process.env.PAYMENTS_MODE
    restoreNodeEnv()
  })
})
