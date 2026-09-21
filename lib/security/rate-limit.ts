import 'server-only'

import { createHash } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { rateLimitCounters } from '@/lib/db/schema'
import { ensureSecuritySchema } from '@/lib/db/security-schema'
import { clientIp } from '@/lib/security/client-ip'

/**
 * Server-side rate limiting / abuse protection.
 *
 * Decisions taken from this deployment's actual shape:
 *  - it runs as a horizontally scaled Next.js server, so an in-process counter
 *    would be trivially defeated by hitting another instance: the counter lives
 *    in PostgreSQL, which the application already depends on
 *  - the increment is ONE atomic statement (`insert ... on conflict update
 *    returning count`), so two simultaneous requests cannot both see a stale
 *    count and slip past the limit
 *  - keys are SHA-256 digests, so this table never becomes a second store of
 *    phone numbers or IP addresses
 *  - a database failure does NOT take the product down: the limiter fails open
 *    and logs, because failing closed would turn a database blip into "nobody
 *    can sign in or withdraw" (documented, deliberate)
 *
 * Limits are per bucket and can be tuned per deployment with
 * `RATE_LIMIT_<BUCKET>_LIMIT` / `RATE_LIMIT_<BUCKET>_WINDOW_MS`. Limits are NOT
 * disabled automatically in development: tests lower them explicitly.
 */

export interface RateLimitPolicy {
  limit: number
  windowMs: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * Default policies. Deliberately generous for legitimate use (a trader can
 * deposit, withdraw and trade repeatedly) and restrictive for the abuse cases
 * that matter: credential guessing, withdrawal/deposit spam, refund spam,
 * expensive admin jobs and unauthenticated webhook floods.
 */
export const RATE_LIMITS = {
  /** OTP codes requested per phone number. */
  otpRequestPhone: { limit: 5, windowMs: 15 * MINUTE },
  /** OTP codes requested per IP address (shared phone numbers / SMS abuse). */
  otpRequestIp: { limit: 20, windowMs: 15 * MINUTE },
  /** Verification attempts per phone number, across challenges (brute force). */
  otpVerifyPhone: { limit: 10, windowMs: 15 * MINUTE },
  otpVerifyIp: { limit: 30, windowMs: 15 * MINUTE },
  /**
   * Failed verifications across EVERY phone number, as a circuit breaker. A
   * deployment-issued code is the same for everybody, so guessing it against a
   * stream of fresh phone numbers never trips a per-phone budget. Short window
   * on purpose: see `lib/auth/otp-abuse.ts` for the trade-off this accepts.
   */
  otpVerifyFailedGlobal: { limit: 50, windowMs: 5 * MINUTE },
  deposit: { limit: 20, windowMs: HOUR },
  withdrawal: { limit: 10, windowMs: HOUR },
  trade: { limit: 240, windowMs: MINUTE },
  referralClaim: { limit: 5, windowMs: HOUR },
  /** Refunds, withdrawal resolution, retries, re-checks, reconciliation, purges. */
  adminAction: { limit: 120, windowMs: MINUTE },
  /** Market creation/changes are rare and expensive. */
  adminMarket: { limit: 30, windowMs: MINUTE },
  /** Provider deliveries, including unauthenticated junk that must not write rows. */
  webhook: { limit: 600, windowMs: MINUTE },
  /** Account/read endpoints that rebuild a whole snapshot. */
  accountRead: { limit: 240, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitPolicy>

export type RateLimitBucket = keyof typeof RATE_LIMITS

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  /** Epoch ms when the current window ends (used for Retry-After). */
  resetAt: number
  count: number
}

/** `RATE_LIMIT_WITHDRAWAL_LIMIT=50` overrides a bucket without a deploy. */
function policyFor(bucket: RateLimitBucket): RateLimitPolicy {
  const base = RATE_LIMITS[bucket]
  const envBucket = bucket.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()
  const limit = Number(process.env[`RATE_LIMIT_${envBucket}_LIMIT`] ?? base.limit)
  const windowMs = Number(process.env[`RATE_LIMIT_${envBucket}_WINDOW_MS`] ?? base.windowMs)
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : base.limit,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : base.windowMs,
  }
}

/** One-way digest so the counter table stores no identifiers. */
export function rateLimitKeyHash(key: string) {
  return createHash('sha256').update(`predik-rate-limit:${key}`).digest('hex')
}

/**
 * Counts one request against `bucket`/`key` and reports whether it is allowed.
 * Never throws for rate-limit reasons; throws only on a database failure, which
 * `enforceRateLimit` converts into a fail-open decision.
 */
export async function consumeRateLimit(input: {
  bucket: RateLimitBucket
  key: string
  /** Units to charge; used by tests that want to pre-fill a window. */
  cost?: number
  now?: number
}): Promise<RateLimitDecision> {
  await ensureSecuritySchema()
  const policy = policyFor(input.bucket)
  const now = input.now ?? Date.now()
  const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs
  const resetAt = windowStart + policy.windowMs
  const keyHash = rateLimitKeyHash(input.key)
  const cost = Math.max(1, Math.floor(input.cost ?? 1))

  const [row] = await db
    .insert(rateLimitCounters)
    .values({
      id: `${input.bucket}:${keyHash}:${windowStart}`,
      bucket: input.bucket,
      keyHash,
      windowStart,
      count: cost,
      expiresAt: resetAt,
    })
    .onConflictDoUpdate({
      target: rateLimitCounters.id,
      set: { count: sql`${rateLimitCounters.count} + ${cost}` },
    })
    .returning({ count: rateLimitCounters.count })

  const count = Number(row?.count ?? cost)
  return {
    allowed: count <= policy.limit,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - count),
    resetAt,
    count,
  }
}

/** Thrown when a caller exceeds its budget; mapped to HTTP 429. */
export class RateLimitExceededError extends Error {
  readonly bucket: RateLimitBucket
  readonly retryAfterSeconds: number
  readonly decision: RateLimitDecision

  constructor(bucket: RateLimitBucket, decision: RateLimitDecision) {
    super('RATE_LIMITED')
    this.name = 'RateLimitExceededError'
    this.bucket = bucket
    this.retryAfterSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))
    this.decision = decision
  }
}

/**
 * Reads what a bucket has already counted, without spending from it.
 *
 * Needed where the decision and the charge are separate events: the shared
 * sign-in failure budget is *checked* before a code is verified but only
 * *charged* when the code turns out to be wrong, so the check cannot be the thing
 * that fills the bucket.
 */
export async function peekRateLimit(input: {
  bucket: RateLimitBucket
  key: string
  now?: number
}): Promise<RateLimitDecision> {
  await ensureSecuritySchema()
  const policy = policyFor(input.bucket)
  const now = input.now ?? Date.now()
  const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs
  const [row] = await db
    .select({ count: rateLimitCounters.count })
    .from(rateLimitCounters)
    .where(eq(rateLimitCounters.id, `${input.bucket}:${rateLimitKeyHash(input.key)}:${windowStart}`))
    .limit(1)
  const count = Number(row?.count ?? 0)
  return {
    allowed: count < policy.limit,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - count),
    resetAt: windowStart + policy.windowMs,
    count,
  }
}

/**
 * Enforces a bucket, throwing `RateLimitExceededError` when the budget is spent.
 * Fails OPEN (and logs) if the counter store is unavailable — see module note.
 */
export async function enforceRateLimit(input: {
  bucket: RateLimitBucket
  key: string
  cost?: number
}): Promise<RateLimitDecision> {
  try {
    const decision = await consumeRateLimit(input)
    if (!decision.allowed) throw new RateLimitExceededError(input.bucket, decision)
    return decision
  } catch (error) {
    if (error instanceof RateLimitExceededError) throw error
    console.error('[security] rate limit store unavailable, allowing request', {
      bucket: input.bucket,
      reason: error instanceof Error ? error.message : 'unknown',
    })
    const policy = policyFor(input.bucket)
    return { allowed: true, limit: policy.limit, remaining: policy.limit, resetAt: Date.now() + policy.windowMs, count: 0 }
  }
}

/** Number of buckets currently over budget is not useful; expose the policy map for docs/admin. */
export function rateLimitPolicies() {
  return Object.fromEntries(
    (Object.keys(RATE_LIMITS) as RateLimitBucket[]).map((bucket) => [bucket, policyFor(bucket)]),
  ) as Record<RateLimitBucket, RateLimitPolicy>
}

/**
 * Coarse client identity for pre-authentication buckets (OTP, webhook floods).
 *
 * The address comes from `clientIp`, which reads the hop the deployment's own
 * proxy appended rather than the first entry in the forwarding chain — the first
 * entry is whatever the caller typed, so honouring it would let one client mint
 * a fresh identity (and a fresh budget) per request.
 */
export function clientKey(request: Request): string {
  return clientIp(request)
}

/**
 * Prunes expired windows. Cheap, bounded, and only ever called opportunistically
 * (roughly one request in `sampleRate`) so it never shows up in a hot path.
 */
export async function pruneRateLimitCounters(limit = 500): Promise<number> {
  try {
    const result = await db.execute(sql`
      delete from rate_limit_counter
      where id in (select id from rate_limit_counter where expires_at < ${Date.now() - MINUTE} limit ${limit})
    `)
    return result.rowCount ?? 0
  } catch {
    return 0
  }
}

let callsSincePrune = 0

/** Fire-and-forget housekeeping, called after a request has been counted. */
export function maybePruneRateLimitCounters(sampleRate = 250) {
  callsSincePrune += 1
  if (callsSincePrune % sampleRate !== 0) return
  void pruneRateLimitCounters().catch(() => undefined)
}
