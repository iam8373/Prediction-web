import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertPaymentTransition,
  canTransition,
  comparePaymentRecords,
  describePaymentStatus,
  isSettledPaymentStatus,
  isTerminalPaymentStatus,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  providerStatusToPaymentStatus,
  toTransactionStatus,
  type PaymentStatus,
  type ProviderStatus,
} from '../../lib/payments/state-machine.ts'

describe('payment state machine', () => {
  it('walks the happy deposit path', () => {
    assert.equal(canTransition('created', 'pending'), true)
    assert.equal(canTransition('pending', 'verified'), true)
    assert.equal(canTransition('verified', 'completed'), true)
  })

  it('never allows a deposit to jump straight from created to completed', () => {
    // Wallet credit must happen through `verified`, so provider truth is
    // recorded (and reconcilable) before money moves.
    assert.equal(canTransition('created', 'completed'), false)
    assert.equal(canTransition('pending', 'completed'), false)
  })

  it('walks the happy withdrawal path and its failure path', () => {
    assert.equal(canTransition('created', 'pending'), true)
    assert.equal(canTransition('pending', 'processing'), true)
    assert.equal(canTransition('processing', 'verified'), true)
    assert.equal(canTransition('verified', 'completed'), true)
    assert.equal(canTransition('processing', 'failed'), true)
    assert.equal(canTransition('pending', 'cancelled'), true)
    assert.equal(canTransition('pending', 'expired'), true)
  })

  it('treats failed, cancelled and expired as terminal', () => {
    for (const status of ['failed', 'cancelled', 'expired'] as PaymentStatus[]) {
      assert.deepEqual(PAYMENT_TRANSITIONS[status], [])
      assert.equal(isTerminalPaymentStatus(status), true)
    }
  })

  it('only lets a completed payment be reversed', () => {
    assert.equal(canTransition('completed', 'refunded'), true)
    assert.equal(canTransition('pending', 'refunded'), false)
    assert.equal(canTransition('refunded', 'completed'), false)
  })

  it('reports which statuses already moved money', () => {
    assert.equal(isSettledPaymentStatus('completed'), true)
    assert.equal(isSettledPaymentStatus('refunded'), true)
    assert.equal(isSettledPaymentStatus('verified'), false)
    assert.equal(isSettledPaymentStatus('pending'), false)
  })

  it('refuses invalid transitions with a coded error', () => {
    assert.throws(() => assertPaymentTransition('completed', 'pending'), /INVALID_PAYMENT_TRANSITION/)
    assert.doesNotThrow(() => assertPaymentTransition('verified', 'completed'))
  })

  it('maps payment statuses onto the existing transaction statuses', () => {
    assert.equal(toTransactionStatus('created'), 'pending')
    assert.equal(toTransactionStatus('pending'), 'pending')
    assert.equal(toTransactionStatus('processing'), 'pending')
    assert.equal(toTransactionStatus('verified'), 'pending')
    assert.equal(toTransactionStatus('completed'), 'completed')
    assert.equal(toTransactionStatus('refunded'), 'completed')
    assert.equal(toTransactionStatus('failed'), 'failed')
    assert.equal(toTransactionStatus('cancelled'), 'failed')
    assert.equal(toTransactionStatus('expired'), 'failed')
  })

  it('maps provider statuses onto internal statuses', () => {
    const cases: Array<[ProviderStatus, PaymentStatus]> = [
      ['created', 'created'],
      ['pending', 'pending'],
      ['processing', 'processing'],
      ['succeeded', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
      ['expired', 'expired'],
      ['refunded', 'refunded'],
      ['partially_refunded', 'partially_refunded'],
    ]
    for (const [provider, internal] of cases) {
      assert.equal(providerStatusToPaymentStatus(provider), internal)
    }
  })

  it('has a human label for every status', () => {
    for (const status of PAYMENT_STATUSES) {
      assert.ok(describePaymentStatus(status).length > 0, `missing label for ${status}`)
    }
  })
})

describe('reconciliation comparison', () => {
  const internal = { status: 'completed' as PaymentStatus, amountPaise: 50_000, currency: 'INR' }

  it('matches when status, amount and currency agree', () => {
    const result = comparePaymentRecords(internal, { status: 'succeeded', amountPaise: 50_000, currency: 'INR' })
    assert.equal(result.status, 'matched')
  })

  it('flags a missing provider record', () => {
    assert.equal(comparePaymentRecords(internal, null).status, 'missing_provider_record')
  })

  it('flags an amount mismatch before anything else', () => {
    const result = comparePaymentRecords(internal, { status: 'succeeded', amountPaise: 49_999, currency: 'INR' })
    assert.equal(result.status, 'amount_mismatch')
  })

  it('flags a currency mismatch', () => {
    const result = comparePaymentRecords(internal, { status: 'succeeded', amountPaise: 50_000, currency: 'USD' })
    assert.equal(result.status, 'currency_mismatch')
  })

  it('flags a status mismatch', () => {
    const result = comparePaymentRecords(internal, { status: 'failed', amountPaise: 50_000, currency: 'INR' })
    assert.equal(result.status, 'status_mismatch')
  })

  it('flags the "provider succeeded but settlement did not complete" state', () => {
    const result = comparePaymentRecords(
      { status: 'verified', amountPaise: 50_000, currency: 'INR' },
      { status: 'succeeded', amountPaise: 50_000, currency: 'INR' },
    )
    assert.equal(result.status, 'mismatch')
    assert.match(result.notes, /settlement/i)
  })

  it('reports nothing as matched by accident', () => {
    const statuses: PaymentStatus[] = ['created', 'pending', 'processing', 'verified', 'completed', 'refunded']
    for (const status of statuses) {
      const result = comparePaymentRecords(
        { status, amountPaise: 1_000, currency: 'INR' },
        { status: 'failed', amountPaise: 1_000, currency: 'INR' },
      )
      assert.notEqual(result.status, 'matched')
    }
  })
})
