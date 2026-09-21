/**
 * Bounded provider status re-check policy.
 *
 * Pure module (no database, no environment) so the retry budget and backoff are
 * unit tested directly. `lib/payments/recheck.ts` applies this policy against
 * real payments.
 *
 * Why a budget at all: a payment can sit in `pending` while the provider already
 * knows the truth, so we do look it up ourselves — but polling forever would hit
 * provider rate limits and hide a real problem. After the budget is spent the
 * payment is handed to a human instead of being retried blindly.
 */

import type { PaymentStatus } from '@/lib/payments/state-machine'

export const RECHECK_POLICY = {
  /** Hard cap on provider lookups for a single payment. */
  maxAttempts: 6,
  /** Payments younger than this are left to the provider's own webhook retry. */
  minAgeMs: 5 * 60_000,
  /** Increasing delay before attempt n+1; the final value repeats. */
  backoffMs: [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000, 72 * 3_600_000],
  /** Payments inspected per run (the provider API is the bottleneck). */
  batchSize: 25,
} as const

/** Statuses that may still be resolved by a provider lookup. */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = ['created', 'pending', 'processing', 'verified']

/** Provider statuses that mean the payment will not change again. */
export const PROVIDER_FINAL_STATUSES: readonly string[] = ['failed', 'cancelled', 'expired']

/** Delay to wait before the next attempt, given how many have happened. */
export function nextRecheckDelayMs(attempts: number): number {
  const schedule = RECHECK_POLICY.backoffMs
  const index = Math.min(Math.max(attempts, 1), schedule.length) - 1
  return schedule[index]
}

/** True when enough time has passed for another provider lookup. */
export function isRecheckDue(input: { attempts: number; lastTouchedAt: number; now: number }): boolean {
  return input.now - input.lastTouchedAt >= nextRecheckDelayMs(input.attempts)
}

/** True when the attempt budget for this payment is spent. */
export function isRecheckExhausted(attempts: number): boolean {
  return attempts >= RECHECK_POLICY.maxAttempts
}
