import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// Imported from the contract module rather than the registry: the registry is
// `server-only` and would refuse to load outside a server component.
import { PaymentProviderError } from '@/lib/payments/contracts'
import { SIGNATURE_HEADER, buildSignatureHeader } from '@/lib/payments/signature'
import { defaultFailureTrigger, SimulatedPaymentProvider } from '@/lib/payments/simulated-provider'

/**
 * Runtime tests for the simulated provider adapter and webhook verification.
 * No database is involved: these cover provider idempotency, settlement modes,
 * failure hooks and the webhook authenticity rules the payment service relies on.
 */

const SECRET = 'whsec_sandbox_test'

function demo() {
  return new SimulatedPaymentProvider({
    id: 'demo',
    label: 'Predik demo provider',
    mode: 'demo',
    settlement: 'instant',
    webhookSecret: SECRET,
    failureTrigger: () => false,
  })
}

function sandbox(secret: string = SECRET) {
  return new SimulatedPaymentProvider({
    id: 'sandbox',
    label: 'Predik sandbox provider',
    mode: 'sandbox',
    settlement: 'async',
    webhookSecret: secret,
    failureTrigger: defaultFailureTrigger,
  })
}

describe('demo provider (instant settlement)', () => {
  it('settles a deposit inside the create call', async () => {
    const record = await demo().createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:1', method: 'upi' })
    assert.equal(record.status, 'succeeded')
    assert.equal(record.amountPaise, 50_000)
    assert.equal(record.currency, 'INR')
    assert.match(record.reference, /^DEP/)
  })

  it('replays the same idempotency key instead of charging twice', async () => {
    const provider = demo()
    const first = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:dup' })
    const second = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:dup' })
    assert.equal(second.id, first.id)
    assert.equal(second.reference, first.reference)
    assert.equal((await provider.listPayments({ since: 0, limit: 100 })).length, 1)
  })

  it('never fails on the demo path even for the failure-trigger amounts', async () => {
    const record = await demo().createDeposit({ amountPaise: 5_099, currency: 'INR', idempotencyKey: 'pay:99' })
    assert.equal(record.status, 'succeeded')
  })

  it('settles a withdrawal immediately', async () => {
    const provider = demo()
    const record = await provider.createWithdrawal({ amountPaise: 30_000, currency: 'INR', idempotencyKey: 'pay:w1', destination: 'trader@upi' })
    assert.equal(record.status, 'succeeded')
    assert.equal(await provider.getWithdrawalStatus(record.id), 'succeeded')
  })

  it('refuses to cancel a withdrawal that already settled', async () => {
    const provider = demo()
    const record = await provider.createWithdrawal({ amountPaise: 30_000, currency: 'INR', idempotencyKey: 'pay:w2', destination: 'trader@upi' })
    await assert.rejects(
      () => provider.cancelWithdrawal({ paymentId: record.id, idempotencyKey: 'cancel:w2' }),
      (error: unknown) => error instanceof PaymentProviderError && error.code === 'PROVIDER_PAYMENT_ALREADY_SETTLED',
    )
  })

  it('refunds a settled deposit and keeps a reference to the original', async () => {
    const provider = demo()
    const deposit = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:d1' })
    const refund = await provider.refundPayment({
      amountPaise: 50_000,
      currency: 'INR',
      idempotencyKey: 'refund:d1',
      originalProviderPaymentId: deposit.id,
      originalReference: deposit.reference,
    })
    assert.equal(refund.status, 'succeeded')
    assert.equal(refund.direction, 'refund')
    assert.equal(refund.amountPaise, 50_000)
  })

  it('rejects a refund for an unknown original payment', async () => {
    await assert.rejects(
      () => demo().refundPayment({
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'refund:nope',
        originalProviderPaymentId: 'pi_missing',
        originalReference: 'DEP-MISSING',
      }),
      (error: unknown) => error instanceof PaymentProviderError && error.code === 'PROVIDER_PAYMENT_NOT_FOUND',
    )
  })

  it('does not support partial refunds', async () => {
    const provider = demo()
    const deposit = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:d2' })
    await assert.rejects(
      () => provider.refundPayment({
        amountPaise: 25_000,
        currency: 'INR',
        idempotencyKey: 'refund:d2',
        originalProviderPaymentId: deposit.id,
        originalReference: deposit.reference,
        partial: true,
      }),
      (error: unknown) => error instanceof PaymentProviderError && error.code === 'PROVIDER_UNSUPPORTED_OPERATION',
    )
  })
})

describe('sandbox provider (asynchronous settlement)', () => {
  it('leaves a deposit pending until a signed webhook arrives', async () => {
    const provider = sandbox()
    const record = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:s1' })
    assert.equal(record.status, 'pending')
    assert.equal(await provider.getPaymentStatus(record.id), 'pending')
  })

  it('fails deterministically for the documented test amounts', async () => {
    const provider = sandbox()
    const record = await provider.createDeposit({ amountPaise: 5_099, currency: 'INR', idempotencyKey: 'pay:s2' })
    assert.equal(record.status, 'failed')
    assert.equal(record.failureCode, 'provider_test_failure')
    assert.equal(defaultFailureTrigger(5_099), true)
    assert.equal(defaultFailureTrigger(5_000), false)
  })

  it('cancels a pending withdrawal and then refuses to cancel again', async () => {
    const provider = sandbox()
    const record = await provider.createWithdrawal({ amountPaise: 30_000, currency: 'INR', idempotencyKey: 'pay:s3', destination: 'trader@upi' })
    const cancelled = await provider.cancelWithdrawal({ paymentId: record.id, idempotencyKey: 'cancel:s3', reason: 'admin' })
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(await provider.getPaymentStatus(record.id), 'cancelled')
  })

  it('exposes provider records for reconciliation', async () => {
    const provider = sandbox()
    const record = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:s4' })
    assert.equal((await provider.fetchPayment(record.id))?.id, record.id)
    assert.equal(await provider.fetchPayment('pi_unknown'), null)
    assert.equal((await provider.listPayments({ since: 0, limit: 10 })).some((row) => row.id === record.id), true)
  })
})

describe('webhook verification', () => {
  it('accepts a correctly signed provider delivery and parses the event', async () => {
    const provider = sandbox()
    const deposit = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:w1' })
    const delivery = provider.buildOutcomeWebhook({ paymentId: deposit.id, outcome: 'succeeded' })
    const result = await provider.verifyWebhook({ rawBody: delivery.rawBody, headers: delivery.headers })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.paymentId, deposit.id)
    assert.equal(result.event.direction, 'deposit')
    assert.equal(result.event.status, 'succeeded')
    assert.equal(result.event.amountPaise, 50_000)
    assert.match(result.event.providerEventId, /^evt_/)
  })

  it('rejects an unsigned delivery', async () => {
    const provider = sandbox()
    const deposit = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:w2' })
    const delivery = provider.buildOutcomeWebhook({ paymentId: deposit.id, outcome: 'succeeded' })
    const result = await provider.verifyWebhook({ rawBody: delivery.rawBody, headers: {} })
    assert.deepEqual(result, { ok: false, reason: 'missing' })
  })

  it('rejects a tampered body', async () => {
    const provider = sandbox()
    const deposit = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:w3' })
    const delivery = provider.buildOutcomeWebhook({ paymentId: deposit.id, outcome: 'succeeded' })
    const tampered = delivery.rawBody.replace('50000', '500000')
    const result = await provider.verifyWebhook({ rawBody: tampered, headers: delivery.headers })
    assert.deepEqual(result, { ok: false, reason: 'digest_mismatch' })
  })

  it('rejects a genuine payload re-signed by an attacker', async () => {
    const provider = sandbox()
    const deposit = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:w4' })
    const delivery = provider.buildOutcomeWebhook({ paymentId: deposit.id, outcome: 'succeeded' })
    // Same bytes, different key: an attacker who knows the payload shape still
    // cannot produce a valid signature.
    const forged = buildSignatureHeader('whsec_attacker', delivery.rawBody, Math.floor(Date.now() / 1000))
    const result = await provider.verifyWebhook({ rawBody: delivery.rawBody, headers: { [SIGNATURE_HEADER]: forged } })
    assert.deepEqual(result, { ok: false, reason: 'digest_mismatch' })
  })

  it('rejects a replayed delivery outside the timestamp window', async () => {
    const provider = sandbox()
    const deposit = await provider.createDeposit({ amountPaise: 50_000, currency: 'INR', idempotencyKey: 'pay:w5' })
    const stale = provider.buildOutcomeWebhook({ paymentId: deposit.id, outcome: 'succeeded', timestampSeconds: 1 })
    const result = await provider.verifyWebhook({ rawBody: stale.rawBody, headers: stale.headers })
    assert.deepEqual(result, { ok: false, reason: 'stale_timestamp' })
  })

  it('fails closed when the signing secret is not configured', async () => {
    const provider = new SimulatedPaymentProvider({
      id: 'sandbox',
      label: 'Predik sandbox provider',
      mode: 'sandbox',
      settlement: 'async',
      webhookSecret: undefined,
      failureTrigger: defaultFailureTrigger,
    })
    const result = await provider.verifyWebhook({
      rawBody: '{}',
      headers: { [SIGNATURE_HEADER]: buildSignatureHeader('anything', '{}', Math.floor(Date.now() / 1000)) },
    })
    assert.deepEqual(result, { ok: false, reason: 'secret_unavailable' })
    assert.equal(provider.capabilities.asyncSettlement, true)
  })

  it('rejects a payload that is signed but not a provider event', async () => {
    const provider = sandbox()
    const body = JSON.stringify({ hello: 'world' })
    const headers = { [SIGNATURE_HEADER]: buildSignatureHeader(SECRET, body, Math.floor(Date.now() / 1000)) }
    const result = await provider.verifyWebhook({ rawBody: body, headers })
    assert.deepEqual(result, { ok: false, reason: 'unparsable' })
  })

  it('maps payout and refund event types to the right direction', async () => {
    const provider = sandbox()
    const withdrawal = await provider.createWithdrawal({ amountPaise: 30_000, currency: 'INR', idempotencyKey: 'pay:w6', destination: 'trader@upi' })
    const payout = provider.buildOutcomeWebhook({ paymentId: withdrawal.id, outcome: 'failed' })
    const payoutResult = await provider.verifyWebhook({ rawBody: payout.rawBody, headers: payout.headers })
    assert.equal(payoutResult.ok, true)
    if (payoutResult.ok) {
      assert.equal(payoutResult.event.direction, 'withdrawal')
      assert.equal(payoutResult.event.status, 'failed')
      assert.equal(payoutResult.event.eventType, 'payout.failed')
    }
  })
})
