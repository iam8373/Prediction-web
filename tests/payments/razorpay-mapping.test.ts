import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EVENT_MAP,
  amountPaiseOf,
  mapEventType,
  mapPaymentStatus,
  mapPayoutStatus,
  mapRefundStatus,
  parseWebhookBody,
  paymentEntityToRecord,
  payoutEntityToRecord,
  refundEntityToRecord,
  webhookEventOf,
} from '@/lib/payments/razorpay/mapping'

/**
 * Pure mapping tests. The awkward provider cases live here: an authorised but
 * uncaptured payment, a reversed payout, an out-of-order/duplicate event, and
 * amounts that must land in integer paise.
 */

describe('razorpay status mapping', () => {
  it('treats an authorised (uncaptured) payment as pending, never as success', () => {
    assert.equal(mapPaymentStatus('authorized'), 'pending')
    assert.equal(mapPaymentStatus('captured'), 'succeeded')
    assert.equal(mapPaymentStatus('failed'), 'failed')
    assert.equal(mapPaymentStatus('refunded'), 'refunded')
  })

  it('maps the payout lifecycle onto internal provider statuses', () => {
    assert.equal(mapPayoutStatus('queued'), 'processing')
    assert.equal(mapPayoutStatus('pending'), 'processing')
    assert.equal(mapPayoutStatus('processing'), 'processing')
    assert.equal(mapPayoutStatus('processed'), 'succeeded')
    // A reversed payout means the money came back: the reservation is released.
    assert.equal(mapPayoutStatus('reversed'), 'failed')
    assert.equal(mapPayoutStatus('cancelled'), 'cancelled')
    assert.equal(mapPayoutStatus('failed'), 'failed')
  })

  it('maps refunds', () => {
    assert.equal(mapRefundStatus('pending'), 'processing')
    assert.equal(mapRefundStatus('processed'), 'succeeded')
    assert.equal(mapRefundStatus('failed'), 'failed')
  })

  it('defaults unknown and missing statuses to a non-final state', () => {
    assert.equal(mapPaymentStatus(undefined), 'pending')
    assert.equal(mapPaymentStatus('something_new'), 'pending')
    assert.equal(mapPayoutStatus(undefined), 'processing')
    assert.equal(mapRefundStatus('something_new'), 'processing')
  })
})

describe('razorpay event mapping', () => {
  it('only claims success for the captured/paid events', () => {
    assert.deepEqual(mapEventType('payment.captured'), { direction: 'deposit', status: 'succeeded' })
    assert.deepEqual(mapEventType('order.paid'), { direction: 'deposit', status: 'succeeded' })
    assert.deepEqual(mapEventType('payment.authorized'), { direction: 'deposit', status: 'pending' })
  })

  it('is case insensitive and rejects unknown events', () => {
    assert.deepEqual(mapEventType('PAYOUT.PROCESSED'), { direction: 'withdrawal', status: 'succeeded' })
    assert.equal(mapEventType('payment.dispute.created'), null)
    assert.equal(mapEventType(undefined), null)
  })

  it('never maps an event to a direction whose entity it cannot carry', () => {
    for (const [eventType, mapping] of Object.entries(EVENT_MAP)) {
      if (mapping.direction === 'withdrawal') assert.match(eventType, /^payout\./)
      if (mapping.direction === 'refund') assert.match(eventType, /^refund\./)
    }
  })
})

describe('razorpay entity -> provider record', () => {
  it('normalizes amounts to integer paise', () => {
    assert.equal(amountPaiseOf({ amount: 50_000 }), 50_000)
    assert.equal(amountPaiseOf({ amount: 50_000, amount_paid: 49_999 }), 49_999)
    assert.equal(amountPaiseOf({ amount: 10_50 }), 1_050)
    assert.equal(amountPaiseOf({}), 0)
  })

  it('carries the internal payment id from notes or the order receipt', () => {
    const fromNotes = paymentEntityToRecord(
      { id: 'pay_1', status: 'captured', amount: 500, notes: { predik_payment_id: 'pay_internal' } },
      'k',
    )
    assert.equal(fromNotes?.internalPaymentId, 'pay_internal')

    const fromReceipt = paymentEntityToRecord({ id: 'pay_2', status: 'captured', amount: 500, receipt: 'pay_internal2' }, 'k')
    assert.equal(fromReceipt?.internalPaymentId, 'pay_internal2')

    // A receipt we did not write must not be treated as our reference.
    const foreign = paymentEntityToRecord({ id: 'pay_3', status: 'captured', amount: 500, receipt: 'ORD-123' }, 'k')
    assert.equal(foreign?.internalPaymentId, undefined)
  })

  it('records the provider failure reason without inventing one on success', () => {
    const failed = paymentEntityToRecord(
      { id: 'pay_4', status: 'failed', amount: 500, error_code: 'BAD_REQUEST_ERROR', error_description: 'card declined' },
      'k',
    )
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.failureCode, 'BAD_REQUEST_ERROR')
    assert.equal(failed?.failureReason, 'card declined')

    const ok = paymentEntityToRecord({ id: 'pay_5', status: 'captured', amount: 500 }, 'k')
    assert.equal(ok?.failureCode, undefined)
    assert.equal(ok?.failureReason, undefined)
  })

  it('returns null for an entity without an id', () => {
    assert.equal(paymentEntityToRecord({ status: 'captured' }, 'k'), null)
  })

  it('maps payout and refund entities with their own directions', () => {
    const payout = payoutEntityToRecord({ id: 'pout_1', status: 'processed', amount: 20_000, currency: 'inr' }, 'k')
    assert.equal(payout?.direction, 'withdrawal')
    assert.equal(payout?.status, 'succeeded')
    assert.equal(payout?.currency, 'INR')

    const refund = refundEntityToRecord({ id: 'rfnd_1', status: 'processed', amount: 20_000 }, 'k')
    assert.equal(refund?.direction, 'refund')
    assert.equal(refund?.status, 'succeeded')
  })
})

describe('razorpay webhook body parsing', () => {
  const body = JSON.stringify({
    event: 'payment.captured',
    created_at: 1_700_000_000,
    payload: {
      payment: {
        entity: {
          id: 'pay_ABC',
          status: 'captured',
          amount: 1_234_00,
          currency: 'INR',
          method: 'upi',
          order_id: 'order_1',
          notes: { predik_payment_id: 'pay_internal' },
        },
      },
    },
  })

  it('extracts the payment, amount, currency and timestamps', () => {
    const parsed = parseWebhookBody(body)
    assert.ok(parsed)
    assert.equal(parsed?.eventType, 'payment.captured')
    assert.equal(parsed?.paymentId, 'pay_ABC')
    assert.equal(parsed?.orderId, 'order_1')
    assert.equal(parsed?.amountPaise, 1_234_00)
    assert.equal(parsed?.currency, 'INR')
    assert.equal(parsed?.internalPaymentId, 'pay_internal')
  })

  it('returns null for bodies it cannot understand', () => {
    assert.equal(parseWebhookBody('not json'), null)
    assert.equal(parseWebhookBody('[]'), null)
    assert.equal(parseWebhookBody('{}'), null)
    assert.equal(parseWebhookBody(JSON.stringify({ event: 'payment.captured' })), null)
  })

  it('builds the internal event with the delivery id as idempotency key', () => {
    const parsed = parseWebhookBody(body)
    assert.ok(parsed)
    const event = webhookEventOf({ payload: parsed!, eventId: 'evt_42' })
    assert.ok(event)
    assert.equal(event?.providerEventId, 'evt_42')
    assert.equal(event?.direction, 'deposit')
    assert.equal(event?.status, 'succeeded')
    assert.equal(event?.amountPaise, 1_234_00)
  })

  it('routes payout and refund events to their own entity ids', () => {
    const payoutBody = JSON.stringify({
      event: 'payout.processed',
      payload: { payout: { entity: { id: 'pout_9', status: 'processed', amount: 5_000, currency: 'INR' } } },
    })
    const payoutEvent = webhookEventOf({ payload: parseWebhookBody(payoutBody)!, eventId: 'evt_p' })
    assert.equal(payoutEvent?.direction, 'withdrawal')
    assert.equal(payoutEvent?.paymentId, 'pout_9')
    assert.equal(payoutEvent?.status, 'succeeded')

    const refundBody = JSON.stringify({
      event: 'refund.failed',
      payload: { refund: { entity: { id: 'rfnd_9', status: 'failed', amount: 5_000, currency: 'INR' } } },
    })
    const refundEvent = webhookEventOf({ payload: parseWebhookBody(refundBody)!, eventId: 'evt_r' })
    assert.equal(refundEvent?.direction, 'refund')
    assert.equal(refundEvent?.paymentId, 'rfnd_9')
    assert.equal(refundEvent?.status, 'failed')
  })

  it('refuses to build an event for an event type we do not act on', () => {
    const parsed = parseWebhookBody(JSON.stringify({
      event: 'payment.dispute.created',
      payload: { payment: { entity: { id: 'pay_X', status: 'captured', amount: 100 } } },
    }))
    assert.ok(parsed)
    assert.equal(webhookEventOf({ payload: parsed!, eventId: 'evt_d' }), null)
  })
})
