import 'server-only'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { publicPaymentConfig, getPaymentConfig } from '@/lib/payments/config'
import { decidePaymentEligibility, setPaymentAccountState } from '@/lib/payments/eligibility'
import { RAZORPAY_ENV, resolvePaymentsMode } from '@/lib/payments/mode'
import { createDepositPayment, createWithdrawalPayment } from '@/lib/payments/service'
import {
  closePool,
  createTestUser,
  databaseUrl,
  ledgerForUser,
  readPayment,
  readWallet,
  resetDatabase,
} from './harness.ts'
import { configureSandboxEnv } from './sandbox.ts'

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'
const UPI = 'gate@okicici'

before(async () => {
  if (skip) return
  configureSandboxEnv()
  await resetDatabase()
})

after(async () => {
  await closePool()
})

/**
 * The live gate is a PURE function of the environment, which is what makes it
 * testable without ever enabling real money: the synthetic environments below
 * are passed as arguments, never written into `process.env`, and no live
 * provider call is ever made.
 */
const COMPLETE_COMPLIANCE = {
  PAYMENTS_MODE: 'live',
  PAYMENTS_LIVE_ACTIVATION: 'true',
  PAYMENTS_COMPLIANCE_ACK: 'RBI-classification-2026-01',
  PAYMENTS_COMPLIANCE_OWNER: 'Head of Compliance',
  PAYMENTS_LIVE_JURISDICTION: 'in',
  PAYMENTS_ALLOWED_LIVE_JURISDICTIONS: 'in',
  PAYMENTS_LIVE_PROVIDER: 'razorpay',
  [RAZORPAY_ENV.liveKeyId]: 'rzp_live_key',
  [RAZORPAY_ENV.liveKeySecret]: 'rzp_live_secret',
  [RAZORPAY_ENV.liveWebhookSecret]: 'rzp_live_whsec',
  [RAZORPAY_ENV.payoutAccountNumber]: '2323230099999',
}

function decide(env: Record<string, string | undefined>, overrides: Partial<{
  sandboxReady: boolean
  liveProviderImplemented: boolean
  liveCredentialsPresent: boolean
  nodeEnv: string
}> = {}) {
  // Credentials are considered present only when the env actually carries them.
  const liveCredentialsPresent = overrides.liveCredentialsPresent
    ?? Boolean(env[RAZORPAY_ENV.liveKeyId] && env[RAZORPAY_ENV.liveKeySecret] && env[RAZORPAY_ENV.liveWebhookSecret] && env[RAZORPAY_ENV.payoutAccountNumber])
  return resolvePaymentsMode({
    env,
    sandboxReady: overrides.sandboxReady ?? true,
    liveProviderImplemented: overrides.liveProviderImplemented ?? true,
    liveCredentialsPresent,
    nodeEnv: overrides.nodeEnv ?? 'production',
  })
}

describe('Live-money activation gate', () => {
  test('live money is disabled in this deployment', { skip }, () => {
    const config = getPaymentConfig()
    assert.equal(config.liveEnabled, false)
    assert.notEqual(config.effective, 'live')
    assert.ok(
      config.requirements.some((requirement) => !requirement.satisfied),
      'the exact unmet live prerequisites are reported to admins',
    )
  })

  test('requesting live without any prerequisite fails closed to sandbox', { skip }, () => {
    const decision = decide({ PAYMENTS_MODE: 'live' })
    assert.equal(decision.liveEnabled, false)
    assert.equal(decision.effective, 'sandbox')
    assert.equal(decision.requested, 'live')
    assert.match(decision.blockers.join(' '), /PAYMENTS_LIVE_ACTIVATION/)
    assert.match(decision.blockers.join(' '), /PAYMENTS_COMPLIANCE_ACK/)
  })

  test('an activation flag alone never enables live money', { skip }, () => {
    const decision = decide({ PAYMENTS_MODE: 'live', PAYMENTS_LIVE_ACTIVATION: 'true' })
    assert.equal(decision.liveEnabled, false)
    assert.equal(decision.effective, 'sandbox')
    assert.match(decision.blockers.join(' '), /PAYMENTS_COMPLIANCE_OWNER/)
  })

  test('credentials alone never enable live money', { skip }, () => {
    const decision = decide({
      PAYMENTS_MODE: 'live',
      [RAZORPAY_ENV.liveKeyId]: 'rzp_live_key',
      [RAZORPAY_ENV.liveKeySecret]: 'rzp_live_secret',
      [RAZORPAY_ENV.liveWebhookSecret]: 'rzp_live_whsec',
      [RAZORPAY_ENV.payoutAccountNumber]: '2323230099999',
    })
    assert.equal(decision.liveEnabled, false)
    assert.equal(decision.effective, 'sandbox')
  })

  test('a non-production runtime refuses live money even with every prerequisite', { skip }, () => {
    const decision = decide(COMPLETE_COMPLIANCE, { nodeEnv: 'development' })
    assert.equal(decision.liveEnabled, false)
    assert.equal(decision.effective, 'sandbox')
    assert.match(decision.blockers.join(' '), /production runtime/)
  })

  test('a jurisdiction that is not allowlisted refuses live money', { skip }, () => {
    const decision = decide({ ...COMPLETE_COMPLIANCE, PAYMENTS_LIVE_JURISDICTION: 'us' })
    assert.equal(decision.liveEnabled, false)
    assert.match(decision.blockers.join(' '), /not in PAYMENTS_ALLOWED_LIVE_JURISDICTIONS/)
  })

  test('missing live credentials refuse live money', { skip }, () => {
    const decision = decide(COMPLETE_COMPLIANCE, { liveCredentialsPresent: false })
    assert.equal(decision.liveEnabled, false)
    assert.match(decision.blockers.join(' '), /credentials are missing/)
  })

  test('an unimplemented live adapter refuses live money', { skip }, () => {
    const decision = decide(COMPLETE_COMPLIANCE, { liveProviderImplemented: false })
    assert.equal(decision.liveEnabled, false)
    assert.match(decision.blockers.join(' '), /No live payment provider adapter/)
  })

  test('the complete prerequisite set is the ONLY thing that enables live money', { skip }, () => {
    const decision = decide(COMPLETE_COMPLIANCE)
    assert.equal(decision.liveEnabled, true, 'the gate opens only when every requirement is satisfied')
    assert.equal(decision.effective, 'live')
    assert.equal(decision.blockers.length, 0)
    // Removing any single prerequisite closes it again. `PAYMENTS_LIVE_PROVIDER`
    // is deliberately excluded: it only *selects* the provider (Razorpay is the
    // default), so its absence is not a missing prerequisite.
    for (const key of Object.keys(COMPLETE_COMPLIANCE)) {
      if (key === 'PAYMENTS_LIVE_PROVIDER') continue
      const partial = { ...COMPLETE_COMPLIANCE }
      delete (partial as Record<string, string | undefined>)[key]
      const closed = decide(partial)
      assert.equal(closed.liveEnabled, false, `removing ${key} must disable live money`)
    }
  })

  test('selecting a provider that has no live adapter closes the gate', { skip }, () => {
    const unsupported = decide({ ...COMPLETE_COMPLIANCE, PAYMENTS_LIVE_PROVIDER: 'payments_r_us' }, { liveProviderImplemented: false })
    assert.equal(unsupported.liveEnabled, false)
    assert.equal(unsupported.effective, 'sandbox')
  })

  test('unknown "enable live" style variables are ignored', { skip }, () => {
    // There is no client flag, query parameter, header or magic variable: only
    // the documented set can move the gate.
    const decision = decide({
      PAYMENTS_MODE: 'live',
      PAYMENTS_LIVE_ENABLE: 'true',
      LIVE_MONEY: '1',
      PAYMENTS_LIVE_FORCE: 'true',
      PAYMENTS_BYPASS_COMPLIANCE: 'true',
      PAYMENTS_DEBUG_LIVE: 'true',
    })
    assert.equal(decision.liveEnabled, false)
    assert.equal(decision.effective, 'sandbox')
  })

  test('a request for live money in this process still creates sandbox payments', { skip }, async () => {
    process.env.PAYMENTS_MODE = 'live'
    try {
      const config = getPaymentConfig()
      assert.equal(config.effective, 'sandbox')
      assert.equal(config.liveEnabled, false)
      const publicView = publicPaymentConfig(config)
      assert.equal(publicView.mode, 'sandbox')
      assert.equal(publicView.liveEnabled, false)
      assert.equal(JSON.stringify(publicView).includes('secret'), false, 'the client projection carries no secrets')

      const { userId } = await createTestUser()
      const deposit = await createDepositPayment({ userId, amountPaise: 20_000, requestKey: 'gate-live-request' })
      const payment = await readPayment(deposit.paymentId)
      assert.equal(payment?.mode, 'sandbox', 'a live request degrades to sandbox, never to live')
      assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    } finally {
      configureSandboxEnv()
    }
  })
})

describe('Payment eligibility decisions', () => {
  function liveConfig(jurisdiction = 'IN') {
    return { ...getPaymentConfig(), effective: 'live' as const, jurisdiction }
  }

  test('demo/sandbox only require an account that is not blocked', { skip }, async () => {
    const { userId } = await createTestUser()
    const decision = await decidePaymentEligibility({ userId, direction: 'withdrawal', mode: 'sandbox', config: getPaymentConfig() })
    assert.equal(decision.decision, 'ELIGIBLE')
  })

  test('real money requires verified identity', { skip }, async () => {
    const { userId } = await createTestUser({ kycStatus: 'unverified' })
    const decision = await decidePaymentEligibility({ userId, direction: 'deposit', mode: 'live', config: liveConfig() })
    assert.equal(decision.decision, 'NOT_ELIGIBLE')
    assert.equal(decision.code, 'PAYMENT_KYC_REQUIRED')
  })

  test('identity under review is a human decision, not a refusal or an approval', { skip }, async () => {
    const { userId } = await createTestUser({ kycStatus: 'pending' })
    const decision = await decidePaymentEligibility({ userId, direction: 'deposit', mode: 'live', config: liveConfig() })
    assert.equal(decision.decision, 'REQUIRES_REVIEW')
    assert.equal(decision.code, 'PAYMENT_KYC_PENDING')
  })

  test('rejected identity cannot transact real money', { skip }, async () => {
    const { userId } = await createTestUser({ kycStatus: 'rejected' })
    const decision = await decidePaymentEligibility({ userId, direction: 'deposit', mode: 'live', config: liveConfig() })
    assert.equal(decision.decision, 'NOT_ELIGIBLE')
    assert.equal(decision.code, 'PAYMENT_KYC_REJECTED')
  })

  test('a verified account still needs explicit live approval', { skip }, async () => {
    const { userId } = await createTestUser({ kycStatus: 'verified', liveEligible: false })
    const decision = await decidePaymentEligibility({ userId, direction: 'deposit', mode: 'live', config: liveConfig() })
    assert.equal(decision.decision, 'REQUIRES_REVIEW')
    assert.equal(decision.code, 'PAYMENT_LIVE_NOT_ELIGIBLE')
  })

  test('a jurisdiction outside the licensed market is refused', { skip }, async () => {
    const { userId } = await createTestUser({ kycStatus: 'verified', liveEligible: true, jurisdiction: 'US' })
    const decision = await decidePaymentEligibility({ userId, direction: 'withdrawal', mode: 'live', config: liveConfig('IN') })
    assert.equal(decision.decision, 'NOT_ELIGIBLE')
    assert.equal(decision.code, 'PAYMENT_JURISDICTION_MISMATCH')
  })

  test('a fully approved account in the licensed jurisdiction is eligible', { skip }, async () => {
    const { userId } = await createTestUser({ kycStatus: 'verified', liveEligible: true, jurisdiction: 'IN' })
    const decision = await decidePaymentEligibility({ userId, direction: 'deposit', mode: 'live', config: liveConfig('IN') })
    assert.equal(decision.decision, 'ELIGIBLE')
  })

  test('a blocked account is refused server-side even in sandbox', { skip }, async () => {
    const { userId } = await createTestUser({ accountStatus: 'blocked' })
    await assert.rejects(
      () => createDepositPayment({ userId, amountPaise: 20_000, requestKey: 'gate-blocked' }),
      /PAYMENT_ACCOUNT_BLOCKED/,
    )
    assert.equal((await ledgerForUser(userId)).length, 0)
  })

  test('a restricted account can deposit but not withdraw', { skip }, async () => {
    const { userId } = await createTestUser({ accountStatus: 'restricted', availablePaise: 100_000 })
    const deposit = await createDepositPayment({ userId, amountPaise: 20_000, requestKey: 'gate-restricted' })
    assert.equal(deposit.status, 'pending')
    await assert.rejects(
      () => createWithdrawalPayment({ userId, amountPaise: 30_000, destination: UPI, requestKey: 'gate-restricted-wdl' }),
      /PAYMENT_ACCOUNT_RESTRICTED/,
    )
  })

  test('an administrator can move an account between states and the decision follows', { skip }, async () => {
    const { userId } = await createTestUser()
    await setPaymentAccountState({ userId, kycStatus: 'verified', liveEligible: true, jurisdiction: 'IN' })
    const approved = await decidePaymentEligibility({ userId, direction: 'deposit', mode: 'live', config: liveConfig('IN') })
    assert.equal(approved.decision, 'ELIGIBLE')

    await setPaymentAccountState({ userId, status: 'blocked', restrictedReason: 'compliance hold' })
    const blocked = await decidePaymentEligibility({ userId, direction: 'deposit', mode: 'live', config: liveConfig('IN') })
    assert.equal(blocked.decision, 'NOT_ELIGIBLE')
    assert.equal(blocked.reason, 'compliance hold')
  })
})
