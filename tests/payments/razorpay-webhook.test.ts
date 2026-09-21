import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
  verifyRazorpayWebhook,
} from '@/lib/payments/razorpay/webhook'

/**
 * Razorpay signs the RAW body with the webhook secret: the header digest is a
 * plain HMAC-SHA256 of the body (no timestamp), and the unique event id travels
 * in `X-Razorpay-event-id`.
 *
 * These tests cover exactly what protects real money here: no secret means
 * rejection, a tampered body is rejected, a delivery without an event id is
 * refused (so a duplicate cannot double-credit), and an authentic delivery for
 * an event type we do not act on is reported rather than treated as an attack.
 */

const SECRET = 'whsec_razorpay_test_secret'

function sign(body: string, secret = SECRET) {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function delivery(eventType: string, entity: Record<string, unknown>, eventId = 'evt_1') {
  return JSON.stringify({
    event: eventType,
    created_at: 1_700_000_000,
    payload: { payment: { entity }, payout: { entity }, refund: { entity } },
  })
}

describe('razorpay webhook verification', () => {
  it('accepts a correctly signed delivery and returns the internal event', () => {
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 50_000, currency: 'INR' })
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: sign(body), [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' },
      secrets: [SECRET],
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.providerEventId, 'evt_1')
    assert.equal(result.event.status, 'succeeded')
    assert.equal(result.event.amountPaise, 50_000)
  })

  it('fails closed when no webhook secret is configured', () => {
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 1 })
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: sign(body), [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' },
      secrets: [undefined, ''],
    })
    assert.deepEqual(result, { ok: false, reason: 'secret_unavailable' })
  })

  it('rejects an unsigned delivery', () => {
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 1 })
    const result = verifyRazorpayWebhook({ rawBody: body, headers: { [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' }, secrets: [SECRET] })
    assert.deepEqual(result, { ok: false, reason: 'missing' })
  })

  it('rejects a body signed with the wrong secret', () => {
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 1 })
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: sign(body, 'whsec_attacker'), [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' },
      secrets: [SECRET],
    })
    assert.deepEqual(result, { ok: false, reason: 'digest_mismatch' })
  })

  it('rejects a tampered body — an attacker cannot upgrade an amount', () => {
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 50_000, currency: 'INR' })
    const tampered = body.replace('50000', '5000000')
    const result = verifyRazorpayWebhook({
      rawBody: tampered,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: sign(body), [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' },
      secrets: [SECRET],
    })
    assert.deepEqual(result, { ok: false, reason: 'digest_mismatch' })
  })

  it('rejects a malformed signature header', () => {
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 1 })
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: 'not-a-digest', [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' },
      secrets: [SECRET],
    })
    assert.deepEqual(result, { ok: false, reason: 'malformed' })
  })

  it('accepts either configured secret during a controlled secret rotation', () => {
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 1 })
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: sign(body, 'whsec_previous'), [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' },
      secrets: [SECRET, 'whsec_previous'],
    })
    assert.equal(result.ok, true)
  })

  it('refuses a signed delivery that carries no event id', () => {
    // Without an event id there is no idempotency key, so a retried delivery
    // could be credited twice. Refusing is the safe outcome.
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 1 })
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: sign(body) },
      secrets: [SECRET],
    })
    assert.deepEqual(result, { ok: false, reason: 'unparsable' })
  })

  it('reports an authentic delivery for an event type we do not act on', () => {
    const body = delivery('payment.dispute.created', { id: 'pay_1', status: 'captured', amount: 1 })
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: sign(body), [RAZORPAY_EVENT_ID_HEADER]: 'evt_9' },
      secrets: [SECRET],
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'unsupported_event')
    assert.equal(result.eventType, 'payment.dispute.created')
    assert.equal(result.eventId, 'evt_9')
  })

  it('rejects an unparsable body even when it is correctly signed', () => {
    const body = '{"event": "payment.captured", '
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: sign(body), [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' },
      secrets: [SECRET],
    })
    assert.deepEqual(result, { ok: false, reason: 'unparsable' })
  })

  it('never echoes the secret in a rejection reason', () => {
    const body = delivery('payment.captured', { id: 'pay_1', status: 'captured', amount: 1 })
    const result = verifyRazorpayWebhook({
      rawBody: body,
      headers: { [RAZORPAY_SIGNATURE_HEADER]: 'zzzz', [RAZORPAY_EVENT_ID_HEADER]: 'evt_1' },
      secrets: [SECRET],
    })
    assert.ok(!JSON.stringify(result).includes(SECRET))
  })
})
