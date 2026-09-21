import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isRecheckDue,
  isRecheckExhausted,
  nextRecheckDelayMs,
  OPEN_PAYMENT_STATUSES,
  PROVIDER_FINAL_STATUSES,
  RECHECK_POLICY,
} from '@/lib/payments/recheck-policy'

/**
 * The re-check policy is what stops a stuck payment from being polled forever.
 * A payment must be re-checked (so a lost webhook cannot cost a user their
 * money) but only a bounded number of times, with growing gaps, and then handed
 * to a human.
 */

describe('re-check backoff', () => {
  it('grows with every attempt', () => {
    const delays = [1, 2, 3, 4, 5].map((attempts) => nextRecheckDelayMs(attempts))
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i] >= delays[i - 1], `attempt ${i + 1} must not wait less than attempt ${i}`)
    }
    assert.ok(delays[4] > delays[0])
  })

  it('never waits less than the first scheduled delay', () => {
    assert.equal(nextRecheckDelayMs(0), RECHECK_POLICY.backoffMs[0])
    assert.equal(nextRecheckDelayMs(1), RECHECK_POLICY.backoffMs[0])
  })

  it('stops growing past the end of the schedule instead of returning undefined', () => {
    const last = RECHECK_POLICY.backoffMs[RECHECK_POLICY.backoffMs.length - 1]
    assert.equal(nextRecheckDelayMs(RECHECK_POLICY.backoffMs.length), last)
    assert.equal(nextRecheckDelayMs(RECHECK_POLICY.maxAttempts + 10), last)
    assert.ok(Number.isFinite(nextRecheckDelayMs(999)))
  })
})

describe('re-check due time', () => {
  it('is not due inside the backoff window', () => {
    const now = 1_000_000_000
    assert.equal(isRecheckDue({ attempts: 1, lastTouchedAt: now, now: now + 60_000 }), false)
  })

  it('is due once the window has elapsed', () => {
    const now = 1_000_000_000
    assert.equal(isRecheckDue({ attempts: 1, lastTouchedAt: now, now: now + nextRecheckDelayMs(1) }), true)
    assert.equal(isRecheckDue({ attempts: 1, lastTouchedAt: now, now: now + nextRecheckDelayMs(1) - 1 }), false)
  })

  it('waits longer for later attempts of the same payment', () => {
    const now = 1_000_000_000
    const lastTouchedAt = now
    const afterFiveMinutes = now + 5 * 60_000
    assert.equal(isRecheckDue({ attempts: 1, lastTouchedAt, now: afterFiveMinutes }), true)
    assert.equal(isRecheckDue({ attempts: 6, lastTouchedAt, now: afterFiveMinutes }), false)
  })
})

describe('re-check budget', () => {
  it('is bounded by maxAttempts', () => {
    assert.equal(isRecheckExhausted(RECHECK_POLICY.maxAttempts - 1), false)
    assert.equal(isRecheckExhausted(RECHECK_POLICY.maxAttempts), true)
    assert.equal(isRecheckExhausted(RECHECK_POLICY.maxAttempts + 1), true)
  })

  it('has a schedule long enough for its budget', () => {
    assert.ok(RECHECK_POLICY.backoffMs.length >= 2)
    assert.ok(RECHECK_POLICY.maxAttempts > 0 && RECHECK_POLICY.maxAttempts <= 20)
    assert.ok(RECHECK_POLICY.batchSize > 0)
  })
})

describe('status sets the re-check relies on', () => {
  it('only re-checks payments that can still change', () => {
    for (const status of OPEN_PAYMENT_STATUSES) {
      assert.ok(['created', 'pending', 'processing', 'verified'].includes(status))
    }
    for (const settled of ['completed', 'failed', 'cancelled', 'expired', 'refunded']) {
      assert.ok(!(OPEN_PAYMENT_STATUSES as readonly string[]).includes(settled))
    }
  })

  it('treats only genuinely final provider statuses as final', () => {
    assert.deepEqual([...PROVIDER_FINAL_STATUSES].sort(), ['cancelled', 'expired', 'failed'])
    // `succeeded` is not "final" here: it is the status that settles money.
    assert.ok(!PROVIDER_FINAL_STATUSES.includes('succeeded'))
  })
})
