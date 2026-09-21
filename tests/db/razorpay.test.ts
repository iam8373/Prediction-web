import 'server-only'

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { after, before, describe, test } from 'node:test'

import { getPaymentConfig } from '@/lib/payments/config'
import { resolveProviderCredentials } from '@/lib/payments/provider-credentials'
import { createDepositPayment, createWithdrawalPayment, refundTransaction } from '@/lib/payments/service'
import { runPaymentReconciliation } from '@/lib/payments/reconciliation'
import {
  closePool,
  createTestUser,
  databaseUrl,
  ledgerForUser,
  rawSql,
  readPayment,
  readWallet,
  resetDatabase,
  transactionsForUser,
} from './harness.ts'
import { deliverWebhook } from './sandbox.ts'

/**
 * Razorpay adapter E2E.
 *
 * The external Razorpay test account is not available in this environment, so
 * the adapter is exercised against a LOCAL stand-in that speaks Razorpay's HTTP
 * contract for orders, payment links, payments, refunds, contacts, fund
 * accounts and payouts. What is real here: the adapter, the client (Basic auth,
 * payout idempotency header, error mapping, timeouts), the webhook signature
 * verification (`X-Razorpay-Signature` over the raw body + `X-Razorpay-event-id`
 * idempotency), the payment service, and PostgreSQL.
 *
 * This is NOT a Razorpay sandbox run and is never reported as one.
 */

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'
const KEY_ID = 'rzp_test_predikkey'
const KEY_SECRET = 'rzp_test_prediksecretvalue'
const WEBHOOK_SECRET = 'whsec_predik_test_value'
const PAYOUT_ACCOUNT = '2323230012345'
const DEPOSIT = 50_000
const WITHDRAWAL = 30_000

interface Standin {
  server: Server
  base: string
  orders: Map<string, Record<string, unknown>>
  payments: Map<string, Record<string, unknown>>
  payouts: Map<string, Record<string, unknown>>
  refunds: Map<string, Record<string, unknown>>
  authHeaders: string[]
  payoutIdempotencyKeys: string[]
  failNextOrderWith?: { status: number; code: string; description: string }
}

let standin: Standin

function json(response: import('node:http').ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function createStandin(): Standin {
  const state: Standin = {
    server: createServer(),
    base: '',
    orders: new Map(),
    payments: new Map(),
    payouts: new Map(),
    refunds: new Map(),
    authHeaders: [],
    payoutIdempotencyKeys: [],
  }
  let counter = 0

  state.server.on('request', async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    state.authHeaders.push(String(request.headers.authorization ?? ''))

    if (state.failNextOrderWith && path === '/orders') {
      const failure = state.failNextOrderWith
      state.failNextOrderWith = undefined
      json(response, failure.status, { error: { code: failure.code, description: failure.description } })
      return
    }
    if (request.headers.authorization !== `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`) {
      json(response, 401, { error: { code: 'AUTH_FAILED', description: 'bad credentials' } })
      return
    }

    const id = (prefix: string) => `${prefix}_${(counter += 1).toString(36).padStart(6, '0')}`
    const now = Math.floor(Date.now() / 1000)

    if (request.method === 'POST' && path === '/orders') {
      const body = await readBody(request)
      const order = {
        id: id('order'),
        entity: 'order',
        amount: body.amount,
        currency: body.currency,
        receipt: body.receipt,
        status: 'created',
        notes: body.notes ?? {},
        created_at: now,
      }
      state.orders.set(String(order.id), order)
      json(response, 200, order)
      return
    }
    if (request.method === 'GET' && path.startsWith('/orders/')) {
      const order = state.orders.get(path.split('/')[2])
      if (!order) return json(response, 404, { error: { code: 'NOT_FOUND' } })
      json(response, 200, order)
      return
    }
    if (request.method === 'POST' && path === '/payment_links') {
      const body = await readBody(request)
      const link = {
        id: id('plink'),
        entity: 'payment_link',
        amount: body.amount,
        currency: body.currency,
        reference_id: body.reference_id,
        status: 'created',
        short_url: `${state.base}/checkout/${id('plink')}`,
        notes: body.notes ?? {},
        created_at: now,
      }
      json(response, 200, link)
      return
    }
    if (request.method === 'POST' && path === '/contacts') {
      const body = await readBody(request)
      json(response, 200, { id: id('cont'), entity: 'contact', name: body.name, reference_id: body.reference_id })
      return
    }
    if (request.method === 'POST' && path === '/fund_accounts') {
      const body = await readBody(request)
      json(response, 200, { id: id('fa'), entity: 'fund_account', contact_id: body.contact_id, account_type: 'vpa' })
      return
    }
    if (request.method === 'POST' && path === '/payouts') {
      const body = await readBody(request)
      state.payoutIdempotencyKeys.push(String(request.headers['x-payout-idempotency'] ?? ''))
      const payout = {
        id: id('pout'),
        entity: 'payout',
        fund_account_id: body.fund_account_id,
        amount: body.amount,
        currency: body.currency,
        // RazorpayX accepts a payout asynchronously: the create call is NOT final.
        status: 'queued',
        reference_id: body.reference_id,
        notes: body.notes ?? {},
        created_at: now,
      }
      state.payouts.set(String(payout.id), payout)
      json(response, 200, payout)
      return
    }
    if (path.startsWith('/payouts/')) {
      const payoutId = path.split('/')[2]
      const payout = state.payouts.get(payoutId)
      if (!payout) return json(response, 404, { error: { code: 'NOT_FOUND' } })
      if (path.endsWith('/cancel')) {
        payout.status = 'cancelled'
        json(response, 200, payout)
        return
      }
      json(response, 200, payout)
      return
    }
    if (request.method === 'POST' && /^\/payments\/[^/]+\/refund$/.test(path)) {
      const paymentId = path.split('/')[2]
      const body = await readBody(request)
      const refund = {
        id: id('rfnd'),
        entity: 'refund',
        payment_id: paymentId,
        amount: body.amount,
        currency: 'INR',
        // Refunds are asynchronous at Razorpay: pending -> processed.
        status: 'pending',
        notes: body.notes ?? {},
        created_at: now,
      }
      state.refunds.set(String(refund.id), refund)
      json(response, 200, refund)
      return
    }
    if (path.startsWith('/refunds/')) {
      const refund = state.refunds.get(path.split('/')[2])
      if (!refund) return json(response, 404, { error: { code: 'NOT_FOUND' } })
      json(response, 200, refund)
      return
    }
    if (path === '/payments' && request.method === 'GET') {
      json(response, 200, { entity: 'collection', count: state.payments.size, items: [...state.payments.values()] })
      return
    }
    if (path.startsWith('/payments/')) {
      const payment = state.payments.get(path.split('/')[2])
      if (!payment) return json(response, 404, { error: { code: 'NOT_FOUND', description: 'no such payment' } })
      json(response, 200, payment)
      return
    }
    json(response, 404, { error: { code: 'NOT_FOUND', description: `unhandled ${request.method} ${path}` } })
  })

  return state
}

async function startStandin() {
  standin = createStandin()
  await new Promise<void>((resolve) => standin.server.listen(0, '127.0.0.1', resolve))
  const address = standin.server.address()
  assert.ok(address && typeof address === 'object')
  standin.base = `http://127.0.0.1:${address.port}`
}

/** Records a payment at the stand-in and returns its provider id. */
function registerPayment(input: { orderId: string; amountPaise: number; internalPaymentId: string; status?: string; method?: string }) {
  const id = `pay_${Math.random().toString(36).slice(2, 10)}`
  standin.payments.set(id, {
    id,
    entity: 'payment',
    order_id: input.orderId,
    amount: input.amountPaise,
    amount_paid: input.status === 'captured' ? input.amountPaise : 0,
    currency: 'INR',
    method: input.method ?? 'upi',
    status: input.status ?? 'created',
    notes: { predik_payment_id: input.internalPaymentId },
    created_at: Math.floor(Date.now() / 1000),
  })
  return id
}

interface RazorpayEventInput {
  eventType: string
  eventId?: string
  section: 'payment' | 'payout' | 'refund'
  entity: Record<string, unknown>
  /** Override the signature (invalid-delivery tests). */
  signature?: string | null
  omitEventId?: boolean
}

function razorpayEvent(input: RazorpayEventInput) {
  const envelope = {
    entity: 'event',
    account_id: 'acc_predik',
    event: input.eventType,
    contains: [input.section],
    payload: { [input.section]: { entity: input.entity } },
    created_at: Math.floor(Date.now() / 1000),
  }
  const rawBody = JSON.stringify(envelope)
  const signature = input.signature === undefined
    ? createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')
    : input.signature
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature) headers['x-razorpay-signature'] = signature
  if (!input.omitEventId) headers['x-razorpay-event-id'] = input.eventId ?? `evt_${Math.random().toString(36).slice(2, 12)}`
  return { rawBody, headers, envelope }
}

function paymentEntity(payment: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { ...payment, ...overrides }
}

before(async () => {
  if (skip) return
  await startStandin()
  process.env.PAYMENTS_MODE = 'sandbox'
  process.env.PAYMENTS_SANDBOX_PROVIDER = 'razorpay'
  process.env.PAYMENTS_RAZORPAY_TEST_KEY_ID = KEY_ID
  process.env.PAYMENTS_RAZORPAY_TEST_KEY_SECRET = KEY_SECRET
  process.env.PAYMENTS_RAZORPAY_TEST_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.PAYMENTS_RAZORPAY_LIVE_KEY_ID = 'rzp_live_should_not_be_used'
  process.env.PAYMENTS_RAZORPAY_LIVE_KEY_SECRET = 'live_secret_should_not_be_used'
  process.env.PAYMENTS_RAZORPAY_LIVE_WEBHOOK_SECRET = 'live_whsec_should_not_be_used'
  process.env.PAYMENTS_RAZORPAY_PAYOUT_ACCOUNT_NUMBER = PAYOUT_ACCOUNT
  process.env.PAYMENTS_RAZORPAY_PAYOUT_MODE = 'UPI'
  process.env.PAYMENTS_RAZORPAY_USE_PAYMENT_LINKS = 'true'
  process.env.PAYMENTS_RAZORPAY_API_BASE = standin.base
  await resetDatabase()
})

after(async () => {
  if (standin?.server) await new Promise<void>((resolve) => standin.server.close(() => resolve()))
  await closePool()
})

describe('Razorpay adapter configuration', () => {
  test('sandbox runs on Razorpay TEST credentials and never on the live key', { skip }, () => {
    const config = getPaymentConfig()
    assert.equal(config.effective, 'sandbox')
    assert.equal(config.providerId, 'razorpay')
    assert.equal(config.sandboxUsesRealProvider, true)
    assert.equal(config.liveEnabled, false)
    assert.equal(resolveProviderCredentials('razorpay', 'sandbox')?.keyId, KEY_ID)
    assert.equal(resolveProviderCredentials('razorpay', 'live')?.keyId, 'rzp_live_should_not_be_used')
    // Sandbox credential resolution can never return the live pair.
    assert.notEqual(resolveProviderCredentials('razorpay', 'sandbox')?.keySecret, 'live_secret_should_not_be_used')
  })

  test('every provider call authenticates with the test key pair', { skip }, async () => {
    const expected = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`
    assert.ok(standin.authHeaders.length >= 0)
    const { userId } = await createTestUser()
    await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-auth' })
    assert.ok(standin.authHeaders.every((header) => header === expected), 'the live key must never reach a sandbox call')
  })
})

describe('Razorpay deposit over real HTTP', () => {
  test('creates an order and a hosted payment link, and does not credit on the redirect', { skip }, async () => {
    const { userId } = await createTestUser()
    const result = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-deposit' })

    assert.equal(result.status, 'pending')
    assert.equal(result.settledImmediately, false)
    assert.ok(result.providerOrderId?.startsWith('order_'))

    // The hosted page is stored for traceability but only handed to the browser
    // when it is an https page on an allowlisted provider host. The local
    // stand-in serves plain http on loopback, which is exactly the shape an
    // open-redirect / SSRF attempt would take, so it must NOT be returned.
    assert.equal(result.checkoutUrl, undefined, 'an unsafe checkout URL must never reach the client')

    const payment = await readPayment(result.paymentId)
    assert.equal(payment?.provider, 'razorpay')
    assert.equal(payment?.mode, 'sandbox')
    assert.equal(payment?.providerOrderRef, result.providerOrderId)
    assert.ok(payment?.checkoutUrl?.startsWith(`${standin.base}/checkout/`), 'the issued link is still recorded internally')
    assert.equal(Number(payment?.amountPaise), DEPOSIT)

    const order = standin.orders.get(String(result.providerOrderId))
    assert.equal(order?.amount, DEPOSIT)
    assert.equal((order?.notes as Record<string, string>)?.predik_payment_id, result.paymentId, 'the internal id travels in notes')

    // The user merely opened the hosted page: no wallet movement.
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.equal((await ledgerForUser(userId)).length, 0)
  })

  test('AUTHORIZED does not credit the wallet', { skip }, async () => {
    const { userId } = await createTestUser()
    const deposit = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-authorized' })
    const payment = await readPayment(deposit.paymentId)
    const providerPaymentId = registerPayment({
      orderId: String(payment?.providerOrderRef),
      amountPaise: DEPOSIT,
      internalPaymentId: deposit.paymentId,
      status: 'authorized',
    })

    const event = razorpayEvent({
      eventType: 'payment.authorized',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    })
    const response = await deliverWebhook(event, 'razorpay')
    assert.equal(response.status, 200)

    const after = await readPayment(deposit.paymentId)
    assert.notEqual(after?.status, 'completed', 'authorised money is not ours yet')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.equal((await ledgerForUser(userId)).length, 0)
  })

  test('a captured payment credited through the order anchor settles exactly once', { skip }, async () => {
    const { userId } = await createTestUser()
    const deposit = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-captured' })
    const payment = await readPayment(deposit.paymentId)
    const providerPaymentId = registerPayment({
      orderId: String(payment?.providerOrderRef),
      amountPaise: DEPOSIT,
      internalPaymentId: deposit.paymentId,
      status: 'captured',
    })

    const captured = razorpayEvent({
      eventType: 'payment.captured',
      eventId: 'evt_captured_1',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    })
    const response = await deliverWebhook(captured, 'razorpay')
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)

    const settled = await readPayment(deposit.paymentId)
    assert.equal(settled?.status, 'completed')
    assert.equal(settled?.providerPaymentId, providerPaymentId)
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT)
    assert.equal((await transactionsForUser(userId)).length, 1)
    assert.equal((await ledgerForUser(userId)).length, 1)

    // Razorpay retries deliveries: the same event id must be a no-op.
    const replay = await deliverWebhook(captured, 'razorpay')
    assert.equal(replay.status, 200)
    assert.equal(replay.body.duplicate, true)
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT)
    assert.equal((await ledgerForUser(userId)).length, 1)

    // `order.paid` is a different event id for the same economic fact.
    const orderPaid = razorpayEvent({
      eventType: 'order.paid',
      eventId: 'evt_order_paid_1',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    })
    assert.equal((await deliverWebhook(orderPaid, 'razorpay')).status, 200)
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT, 'one payment, one credit')
    assert.equal((await ledgerForUser(userId)).length, 1)
  })

  test('a capture whose notes name a different internal payment is refused and flagged', { skip }, async () => {
    const { userId } = await createTestUser()
    const deposit = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-wrong-ref' })
    const payment = await readPayment(deposit.paymentId)
    const providerPaymentId = registerPayment({
      orderId: String(payment?.providerOrderRef),
      amountPaise: DEPOSIT,
      internalPaymentId: 'pay_somebody_elses_payment',
      status: 'captured',
    })

    const captured = razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    })
    assert.equal((await deliverWebhook(captured, 'razorpay')).status, 200)

    const after = await readPayment(deposit.paymentId)
    assert.notEqual(after?.status, 'completed', 'an event that belongs to another payment must never settle this one')
    assert.equal(after?.reconciliationStatus, 'mismatch')
    assert.equal(after?.failureCode, 'PAYMENT_REFERENCE_MISMATCH')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
  })

  test('a captured amount that differs from the order is refused and flagged', { skip }, async () => {
    const { userId } = await createTestUser()
    const deposit = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-amount' })
    const payment = await readPayment(deposit.paymentId)
    const providerPaymentId = registerPayment({
      orderId: String(payment?.providerOrderRef),
      amountPaise: DEPOSIT + 1_000,
      internalPaymentId: deposit.paymentId,
      status: 'captured',
    })

    const captured = razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    })
    assert.equal((await deliverWebhook(captured, 'razorpay')).status, 200)
    const after = await readPayment(deposit.paymentId)
    assert.notEqual(after?.status, 'completed')
    assert.equal(after?.failureCode, 'PAYMENT_AMOUNT_MISMATCH')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
  })
})

describe('Razorpay webhook delivery (real signature scheme)', () => {
  async function pendingDeposit(requestKey: string) {
    const { userId } = await createTestUser()
    const deposit = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey })
    const payment = await readPayment(deposit.paymentId)
    const providerPaymentId = registerPayment({
      orderId: String(payment?.providerOrderRef),
      amountPaise: DEPOSIT,
      internalPaymentId: deposit.paymentId,
      status: 'captured',
    })
    return { userId, deposit, providerPaymentId }
  }

  test('an invalid signature is rejected', { skip }, async () => {
    const { userId, deposit, providerPaymentId } = await pendingDeposit('rzp-bad-sig')
    const event = razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
      signature: 'deadbeef'.repeat(8),
    })
    assert.equal((await deliverWebhook(event, 'razorpay')).status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.notEqual((await readPayment(deposit.paymentId))?.status, 'completed')
  })

  test('a missing signature is rejected', { skip }, async () => {
    const { userId, deposit, providerPaymentId } = await pendingDeposit('rzp-no-sig')
    const event = razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
      signature: null,
    })
    assert.equal((await deliverWebhook(event, 'razorpay')).status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.notEqual((await readPayment(deposit.paymentId))?.status, 'completed')
  })

  test('an authentic delivery without an event id is refused (cannot be made idempotent)', { skip }, async () => {
    const { userId, deposit, providerPaymentId } = await pendingDeposit('rzp-no-event-id')
    const event = razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
      omitEventId: true,
    })
    assert.equal((await deliverWebhook(event, 'razorpay')).status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.notEqual((await readPayment(deposit.paymentId))?.status, 'completed')
  })

  test('an authentic but unhandled event type is acknowledged, not retried forever', { skip }, async () => {
    const event = razorpayEvent({
      eventType: 'payment_link.paid',
      eventId: 'evt_unsupported_1',
      section: 'payment',
      entity: paymentEntity({ id: 'plink_unhandled', entity: 'payment_link', amount: DEPOSIT, currency: 'INR', status: 'paid' }),
    })
    const response = await deliverWebhook(event, 'razorpay')
    assert.equal(response.status, 200)
    assert.equal(response.body.ignored, true)
    assert.equal(response.body.reason, 'UNSUPPORTED_EVENT')

    const rows = await rawSql<{ status: string }>('select status from payment_webhook_event where provider_event_id = $1', ['evt_unsupported_1'])
    assert.equal(rows[0]?.status, 'ignored', 'recorded as authentic-but-unhandled, never as an attack')
  })

  test('a webhook for an unknown payment is ignored without side effects', { skip }, async () => {
    const event = razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity({ id: 'pay_unknown_xyz', entity: 'payment', order_id: null, amount: DEPOSIT, currency: 'INR', status: 'captured', notes: {} }),
    })
    const response = await deliverWebhook(event, 'razorpay')
    assert.equal(response.status, 200)
    assert.equal(response.body.reason, 'PAYMENT_NOT_FOUND')
  })

  test('a tampered body fails signature verification', { skip }, async () => {
    const { userId, deposit, providerPaymentId } = await pendingDeposit('rzp-tamper')
    const event = razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    })
    const tampered = { rawBody: event.rawBody.replace('"captured"', '"created"'), headers: event.headers }
    assert.equal((await deliverWebhook(tampered, 'razorpay')).status, 401)
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.notEqual((await readPayment(deposit.paymentId))?.status, 'completed')
  })
})

describe('Razorpay withdrawal (payout) over real HTTP', () => {
  test('a queued payout keeps the funds reserved and only a processed payout settles it', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: 100_000 })
    const withdrawal = await createWithdrawalPayment({ userId, amountPaise: WITHDRAWAL, destination: 'predik@upi', requestKey: 'rzp-payout' })

    const payment = await readPayment(withdrawal.paymentId)
    assert.ok(payment?.providerPaymentId?.startsWith('pout_'))
    assert.equal(payment?.providerDestinationRef?.startsWith('fa_'), true, 'the fund account is reused across retries')
    assert.equal(payment?.status, 'processing', 'a queued payout is not final')
    assert.equal(Number((await readWallet(userId)).lockedPaise), WITHDRAWAL)
    assert.equal(Number((await readWallet(userId)).availablePaise), 100_000 - WITHDRAWAL)

    // RazorpayX requires a payout idempotency key on every create.
    assert.equal(standin.payoutIdempotencyKeys.length, 1)
    assert.equal(standin.payoutIdempotencyKeys[0], payment?.providerIdempotencyKey)

    const payout = standin.payouts.get(String(payment?.providerPaymentId)) as Record<string, unknown>
    payout.status = 'processed'
    const processed = razorpayEvent({
      eventType: 'payout.processed',
      section: 'payout',
      entity: payout,
    })
    assert.equal((await deliverWebhook(processed, 'razorpay')).status, 200)

    const settled = await readPayment(withdrawal.paymentId)
    assert.equal(settled?.status, 'completed')
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.lockedPaise), 0)
    assert.equal(Number(wallet.availablePaise), 100_000 - WITHDRAWAL)
    assert.equal((await ledgerForUser(userId)).length, 1)
    assert.equal((await transactionsForUser(userId))[0].status, 'completed')
  })

  test('a reversed payout after settlement never silently reverts the debit', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: 100_000 })
    const withdrawal = await createWithdrawalPayment({ userId, amountPaise: WITHDRAWAL, destination: 'predik@upi', requestKey: 'rzp-reversed' })
    const payment = await readPayment(withdrawal.paymentId)
    const payout = standin.payouts.get(String(payment?.providerPaymentId)) as Record<string, unknown>
    payout.status = 'processed'
    assert.equal((await deliverWebhook(razorpayEvent({ eventType: 'payout.processed', section: 'payout', entity: payout }), 'razorpay')).status, 200)
    const settledWallet = await readWallet(userId)

    const reversed = razorpayEvent({
      eventType: 'payout.reversed',
      eventId: 'evt_reversed_1',
      section: 'payout',
      entity: { ...payout, status: 'reversed' },
    })
    assert.equal((await deliverWebhook(reversed, 'razorpay')).status, 200)

    const after = await readPayment(withdrawal.paymentId)
    assert.equal(after?.status, 'completed', 'the settled state is preserved')
    assert.equal(after?.reconciliationStatus, 'mismatch', 'and the divergence is flagged for a human')
    assert.equal(Number((await readWallet(userId)).availablePaise), Number(settledWallet.availablePaise))
  })

  test('a failed payout releases the reservation over the real adapter', { skip }, async () => {
    const { userId } = await createTestUser({ availablePaise: 100_000 })
    const withdrawal = await createWithdrawalPayment({ userId, amountPaise: WITHDRAWAL, destination: 'predik@upi', requestKey: 'rzp-payout-fail' })
    const payment = await readPayment(withdrawal.paymentId)
    const payout = standin.payouts.get(String(payment?.providerPaymentId)) as Record<string, unknown>

    const failed = razorpayEvent({
      eventType: 'payout.failed',
      section: 'payout',
      entity: { ...payout, status: 'failed', error_description: 'beneficiary bank declined' },
    })
    assert.equal((await deliverWebhook(failed, 'razorpay')).status, 200)

    assert.equal((await readPayment(withdrawal.paymentId))?.status, 'failed')
    const wallet = await readWallet(userId)
    assert.equal(Number(wallet.availablePaise), 100_000)
    assert.equal(Number(wallet.lockedPaise), 0)
  })
})

describe('Razorpay refund over real HTTP', () => {
  async function capturedDeposit(requestKey: string) {
    const { userId } = await createTestUser()
    const deposit = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey })
    const payment = await readPayment(deposit.paymentId)
    const providerPaymentId = registerPayment({
      orderId: String(payment?.providerOrderRef),
      amountPaise: DEPOSIT,
      internalPaymentId: deposit.paymentId,
      status: 'captured',
    })
    assert.equal((await deliverWebhook(razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    }), 'razorpay')).status, 200)
    const settled = await readPayment(deposit.paymentId)
    assert.equal(settled?.status, 'completed')
    return { userId, deposit, transactionId: settled?.transactionId as string }
  }

  test('a pending provider refund settles only when the provider processes it', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId, transactionId } = await capturedDeposit('rzp-refund')

    const refund = await refundTransaction({ adminUserId: adminId, transactionId, reason: 'duplicate payment' })
    assert.equal(refund.status, 'pending', 'Razorpay refunds are asynchronous')
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT, 'no reversal before the provider confirms')

    const refundPayment = await readPayment(refund.transactionId)
    assert.ok(refundPayment?.providerPaymentId?.startsWith('rfnd_'))

    const stored = standin.refunds.get(String(refundPayment.providerPaymentId)) as Record<string, unknown>
    stored.status = 'processed'
    const processed = razorpayEvent({
      eventType: 'refund.processed',
      section: 'refund',
      entity: stored,
    })
    assert.equal((await deliverWebhook(processed, 'razorpay')).status, 200)

    assert.equal((await readPayment(refund.transactionId))?.status, 'completed')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.equal((await ledgerForUser(userId)).filter((row) => row.type === 'refund').length, 1)
    assert.equal((await readPayment(refundPayment.parentPaymentId as string))?.status, 'refunded')
  })

  test('a provider refund failure leaves the wallet credited and the refund failed', { skip }, async () => {
    const { userId: adminId } = await createTestUser({ isAdmin: true })
    const { userId, transactionId } = await capturedDeposit('rzp-refund-fail')
    const { userId: secondAdmin } = await createTestUser({ isAdmin: true })

    const refund = await refundTransaction({ adminUserId: adminId, transactionId })
    const refundPayment = await readPayment(refund.transactionId)
    assert.ok(refundPayment?.providerPaymentId)
    const stored = standin.refunds.get(String(refundPayment.providerPaymentId)) as Record<string, unknown>
    stored.status = 'failed'

    const failed = razorpayEvent({
      eventType: 'refund.failed',
      section: 'refund',
      entity: stored,
    })
    assert.equal((await deliverWebhook(failed, 'razorpay')).status, 200)

    const after = await readPayment(refund.transactionId)
    assert.equal(after?.status, 'failed')
    assert.equal(Number((await readWallet(userId)).availablePaise), DEPOSIT, 'the money is still credited')
    assert.equal((await ledgerForUser(userId)).filter((row) => row.type === 'refund').length, 0)
    assert.ok(secondAdmin)
  })
})

describe('Razorpay reconciliation on real HTTP data', () => {
  test('a captured deposit reconciles as matched through the provider API', { skip }, async () => {
    const { userId } = await createTestUser()
    const deposit = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-recon' })
    const payment = await readPayment(deposit.paymentId)
    const providerPaymentId = registerPayment({
      orderId: String(payment?.providerOrderRef),
      amountPaise: DEPOSIT,
      internalPaymentId: deposit.paymentId,
      status: 'captured',
    })
    assert.equal((await deliverWebhook(razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    }), 'razorpay')).status, 200)

    const run = await runPaymentReconciliation({ providerId: 'razorpay', limit: 100 })
    assert.equal(run.status, 'completed')
    const findings = await rawSql<{ status: string }>('select status from payment_reconciliation_finding where payment_intent_id = $1', [deposit.paymentId])
    assert.equal(findings[0]?.status, 'matched')
  })

  test('a provider 404 is reported as a missing provider record', { skip }, async () => {
    const { userId } = await createTestUser()
    const deposit = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-recon-404' })
    const payment = await readPayment(deposit.paymentId)
    assert.ok(payment?.providerPaymentId)
    // Settle it first so the payment reconciles against the provider PAYMENT,
    // then make the provider forget it: GET /payments/:id answers 404.
    const providerPaymentId = registerPayment({
      orderId: String(payment?.providerOrderRef),
      amountPaise: DEPOSIT,
      internalPaymentId: deposit.paymentId,
      status: 'captured',
    })
    assert.equal((await deliverWebhook(razorpayEvent({
      eventType: 'payment.captured',
      section: 'payment',
      entity: paymentEntity(standin.payments.get(providerPaymentId) as Record<string, unknown>),
    }), 'razorpay')).status, 200)
    standin.payments.delete(providerPaymentId)

    await runPaymentReconciliation({ providerId: 'razorpay', limit: 100 })
    const findings = await rawSql<{ status: string }>('select status from payment_reconciliation_finding where payment_intent_id = $1', [deposit.paymentId])
    assert.equal(findings[0]?.status, 'missing_provider_record')
  })

  test('a provider outage leaves the payment pending instead of failing or crediting it', { skip }, async () => {
    const { userId } = await createTestUser()
    standin.failNextOrderWith = { status: 503, code: 'SERVER_ERROR', description: 'gateway unavailable' }

    const result = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-outage' })
    assert.equal(result.status, 'pending', 'an indeterminate provider failure is never a failure and never a success')

    const payment = await readPayment(result.paymentId)
    assert.equal(payment?.providerStatus, 'indeterminate')
    assert.equal(payment?.reconciliationStatus, 'pending', 'the payment is handed to reconciliation, not guessed')
    assert.equal(Number((await readWallet(userId)).availablePaise), 0)
    assert.equal((await ledgerForUser(userId)).length, 0)
  })

  test('provider error text is redacted before it can reach a log or a response', { skip }, async () => {
    const { userId } = await createTestUser()
    standin.failNextOrderWith = {
      status: 400,
      code: 'BAD_REQUEST_ERROR',
      description: `request signed with ${KEY_SECRET} was rejected`,
    }
    const result = await createDepositPayment({ userId, amountPaise: DEPOSIT, method: 'upi', requestKey: 'rzp-redact' })
    assert.equal(result.status, 'failed')
    const payment = await readPayment(result.paymentId)
    assert.ok(payment?.failureReason)
    assert.equal(payment?.failureReason?.includes(KEY_SECRET), false, 'the key secret must never be stored')
  })
})
