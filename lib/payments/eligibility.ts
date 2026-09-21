import 'server-only'

import { eq } from 'drizzle-orm'

import { db, type DbClient } from '@/lib/db'
import { paymentAccounts } from '@/lib/db/schema'
import type { PaymentConfig } from '@/lib/payments/config'
import type { PaymentDirection } from '@/lib/payments/state-machine'
import type { PaymentEligibilityResult } from '@/types'

/**
 * Payment eligibility / account state.
 *
 * Kept separate from the `user` table so existing accounts, authentication and
 * trading are untouched. Demo and sandbox money only requires an account that
 * is not blocked; real money additionally requires a verified KYC status and an
 * explicit live-eligibility approval (plus the live gate itself).
 */

export type PaymentAccountStatus = 'active' | 'restricted' | 'blocked'
export type PaymentKycStatus = 'unverified' | 'pending' | 'verified' | 'rejected'

export async function getOrCreatePaymentAccount(userId: string, client: DbClient = db) {
  const [existing] = await client.select().from(paymentAccounts).where(eq(paymentAccounts.userId, userId)).limit(1)
  if (existing) return existing
  const [created] = await client
    .insert(paymentAccounts)
    .values({ userId, status: 'active', kycStatus: 'unverified', liveEligible: false })
    .onConflictDoNothing()
    .returning()
  if (created) return created
  const [raced] = await client.select().from(paymentAccounts).where(eq(paymentAccounts.userId, userId)).limit(1)
  return raced
}

/**
 * The single server-side eligibility decision. It is enforced by the payment
 * service and can also be inspected by an administrator, so the reason a
 * payment was refused is never a client-side guess.
 *
 *   ELIGIBLE        — may transact in this mode
 *   NOT_ELIGIBLE    — must not transact (blocked account, failed KYC, ...)
 *   REQUIRES_REVIEW — a human must decide before money moves
 *
 * Registered users are NOT automatically eligible for real money.
 */
export async function decidePaymentEligibility(input: {
  userId: string
  direction: PaymentDirection
  mode: PaymentConfig['effective']
  config: PaymentConfig
  client?: DbClient
}): Promise<PaymentEligibilityResult> {
  const account = await getOrCreatePaymentAccount(input.userId, input.client ?? db)
  if (!account) {
    return { decision: 'NOT_ELIGIBLE', code: 'ACCOUNT_NOT_READY', reason: 'The wallet is not ready for payments', mode: input.mode }
  }

  const base = { mode: input.mode, jurisdiction: account.jurisdiction ?? undefined } as const

  if (account.status === 'blocked') {
    return { ...base, decision: 'NOT_ELIGIBLE', code: 'PAYMENT_ACCOUNT_BLOCKED', reason: account.restrictedReason ?? 'This account is blocked from payments' }
  }
  if (account.status === 'restricted' && input.direction !== 'deposit') {
    return { ...base, decision: 'NOT_ELIGIBLE', code: 'PAYMENT_ACCOUNT_RESTRICTED', reason: account.restrictedReason ?? 'Withdrawals are restricted on this account' }
  }

  // Demo and sandbox money only needs an account that is not blocked.
  if (input.mode !== 'live') return { ...base, decision: 'ELIGIBLE' }

  // Real money requires an approved, KYC-verified account in a jurisdiction the
  // deployment is licensed to operate in. The live gate itself has already been
  // evaluated by the caller.
  if (account.kycStatus === 'pending') {
    return { ...base, decision: 'REQUIRES_REVIEW', code: 'PAYMENT_KYC_PENDING', reason: 'Identity verification is still in progress' }
  }
  if (account.kycStatus === 'rejected') {
    return { ...base, decision: 'NOT_ELIGIBLE', code: 'PAYMENT_KYC_REJECTED', reason: 'Identity verification was rejected' }
  }
  if (account.kycStatus !== 'verified') {
    return { ...base, decision: 'NOT_ELIGIBLE', code: 'PAYMENT_KYC_REQUIRED', reason: 'Identity verification is required before real-money payments' }
  }
  if (!account.liveEligible) {
    return { ...base, decision: 'REQUIRES_REVIEW', code: 'PAYMENT_LIVE_NOT_ELIGIBLE', reason: 'This account has not been approved for real-money payments' }
  }
  const jurisdiction = account.jurisdiction ?? input.config.jurisdiction
  if (!jurisdiction) {
    return { ...base, decision: 'REQUIRES_REVIEW', code: 'PAYMENT_JURISDICTION_UNKNOWN', reason: 'The account jurisdiction is not established' }
  }
  if (input.config.jurisdiction && account.jurisdiction && account.jurisdiction !== input.config.jurisdiction) {
    return { ...base, decision: 'NOT_ELIGIBLE', code: 'PAYMENT_JURISDICTION_MISMATCH', reason: 'This account is outside the licensed jurisdiction' }
  }
  return { ...base, decision: 'ELIGIBLE' }
}

/**
 * Throws a coded error when the account may not perform this payment in this
 * mode. Codes are mapped to HTTP responses by the route handlers.
 */
export async function assertPaymentEligibility(input: {
  userId: string
  direction: PaymentDirection
  mode: PaymentConfig['effective']
  config: PaymentConfig
  client?: DbClient
}): Promise<void> {
  const decision = await decidePaymentEligibility(input)
  if (decision.decision === 'ELIGIBLE') return
  throw new Error(decision.code ?? 'PAYMENT_NOT_ELIGIBLE')
}

export async function setPaymentAccountState(input: {
  userId: string
  status?: PaymentAccountStatus
  kycStatus?: PaymentKycStatus
  liveEligible?: boolean
  jurisdiction?: string
  restrictedReason?: string
  client?: DbClient
}) {
  const client = input.client ?? db
  await getOrCreatePaymentAccount(input.userId, client)
  const [updated] = await client
    .update(paymentAccounts)
    .set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.kycStatus ? { kycStatus: input.kycStatus } : {}),
      ...(input.liveEligible !== undefined ? { liveEligible: input.liveEligible } : {}),
      ...(input.jurisdiction ? { jurisdiction: input.jurisdiction } : {}),
      ...(input.restrictedReason !== undefined ? { restrictedReason: input.restrictedReason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(paymentAccounts.userId, input.userId))
    .returning()
  return updated
}
