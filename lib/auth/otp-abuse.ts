import 'server-only'

import { consumeRateLimit, peekRateLimit, RateLimitExceededError } from '@/lib/security/rate-limit'

/**
 * Circuit breaker for sign-in code guessing.
 *
 * The per-phone and per-IP budgets cannot see this attack: a deployment-issued
 * code (`OTP_FIXED_CODE`) is the *same* code for every account, so it can be
 * guessed against a stream of fresh phone numbers without ever tripping a
 * per-phone limit. Counting failures across every number is what makes that
 * enumeration cost something.
 *
 * The trade-off is explicit: the budget is shared, so an attacker who spends it
 * can (briefly) stop legitimate users from verifying a code. That is why the
 * window is short — measured in minutes, not hours — and why the limit is
 * generous enough that ordinary users never reach it; an operator seeing this
 * trip in the logs should treat it as an attack in progress, not as normal load.
 * Raise it with `RATE_LIMIT_OTP_VERIFY_FAILED_GLOBAL_LIMIT` on a deployment whose
 * sign-in traffic is genuinely large.
 */

/** One key for the whole deployment: this budget is deliberately not per user. */
const SHARED_KEY = 'all-phones'

/**
 * Throws `RateLimitExceededError` (mapped to HTTP 429 with `Retry-After`) when
 * the shared failure budget is spent. Verified *before* a code is checked, so a
 * caller cannot spend the budget and keep guessing in the same window.
 *
 * Fails open if the counter store is unreachable, matching the limiter's
 * documented behaviour: a database outage must not become a sign-in outage.
 */
export async function assertOtpVerificationAllowed(): Promise<void> {
  try {
    const decision = await peekRateLimit({ bucket: 'otpVerifyFailedGlobal', key: SHARED_KEY })
    if (!decision.allowed) throw new RateLimitExceededError('otpVerifyFailedGlobal', decision)
  } catch (error) {
    if (error instanceof RateLimitExceededError) throw error
    console.error('[auth] could not read the sign-in failure budget, allowing verification', {
      reason: error instanceof Error ? error.message : 'unknown',
    })
  }
}

/**
 * Records one failed verification against the shared budget. Never throws: the
 * failure being recorded is already the response to the caller, and losing a
 * counter must not change that response.
 */
export async function recordOtpVerificationFailure(): Promise<void> {
  try {
    await consumeRateLimit({ bucket: 'otpVerifyFailedGlobal', key: SHARED_KEY })
  } catch (error) {
    console.error('[auth] could not record a failed sign-in attempt', {
      reason: error instanceof Error ? error.message : 'unknown',
    })
  }
}
