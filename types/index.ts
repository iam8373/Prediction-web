/**
 * Domain types for the Predik web app.
 *
 * Money is ALWAYS an integer number of paise (1 INR = 100 paise).
 * Share quantities are ALWAYS integer milli-shares (1 share = 1000 milli-shares).
 * No float arithmetic is used anywhere in the financial path.
 */

import type { PaymentDirection, PaymentStatus, ProviderStatus, ReconciliationStatus } from '@/lib/payments/state-machine'

export type MarketStatus = 'open' | 'paused' | 'closed' | 'resolved'
export type MarketKind = 'binary' | 'match'
export type OutcomeSide = 'yes' | 'no'

export interface Category {
  id: string
  name: string
  slug: string
  icon: string
  accent: string
}

export interface MarketOutcome {
  id: string
  marketId: string
  /** "Yes" / "No" or a team short name such as "NDT". */
  name: string
  side: OutcomeSide
  /** Price per share in paise, out of a ₹10 (1000 paise) settlement. */
  pricePaise: number
  /** Price 24h ago, used for movement indicators. */
  previousPricePaise: number
}

export interface PricePoint {
  /** Unix ms timestamp. */
  t: number
  /** Yes price in paise (out of 1000). */
  yes: number
}

export interface MarketStats {
  tradeCount: number
  volumePaise: number
  participants: number
}

export interface Market {
  id: string
  slug: string
  question: string
  /** Short headline used on compact cards, e.g. "NDT vs WDL". */
  headline: string
  description: string
  resolutionCriteria: string
  source: string
  categoryId: string
  kind: MarketKind
  status: MarketStatus
  league?: string
  emblem: string
  /** YouTube video this market is about, when one is attached. Display only. */
  videoId?: string
  live: boolean
  featured: boolean
  bonus: boolean
  createdAt: number
  opensAt: number
  closesAt: number
  resolvesAt: number
  /** Outcome id of the winning outcome once resolved. */
  resolvedOutcomeId?: string
  volumePaise: number
  liquidityPaise: number
  traders: number
  outcomes: MarketOutcome[]
  priceHistory: PricePoint[]
}

export type TransactionType =
  | 'deposit'
  | 'withdrawal'
  | 'buy'
  | 'sell'
  | 'payout'
  | 'fee'
  | 'refund'
  | 'bonus'

export type TransactionStatus = 'pending' | 'completed' | 'failed'

export interface Transaction {
  id: string
  reference: string
  type: TransactionType
  /** Signed amount in paise. Positive credits the wallet, negative debits it. */
  amountPaise: number
  status: TransactionStatus
  createdAt: number
  description: string
  marketId?: string
}

export interface Position {
  id: string
  marketId: string
  outcomeId: string
  /** Integer milli-shares (1000 = 1 share). */
  milliShares: number
  /** Volume weighted average entry price in paise. */
  averagePricePaise: number
  /** Cash realised from sells + settlements, in paise. */
  realisedPnlPaise: number
  status: 'open' | 'closed' | 'settled'
  createdAt: number
  updatedAt: number
}

export interface Trade {
  id: string
  marketId: string
  outcomeId: string
  side: 'buy' | 'sell'
  milliShares: number
  pricePaise: number
  amountPaise: number
  createdAt: number
  trader?: string
}

export interface Wallet {
  availablePaise: number
  lockedPaise: number
  bonusPaise: number
}

export type NotificationKind = 'trade' | 'settlement' | 'market' | 'account'

export interface Notification {
  id: string
  eventKey: string
  kind: NotificationKind
  title: string
  description: string
  href?: string
  readAt?: number
  createdAt: number
}

export interface ReferralSummary {
  code: string
  invitedCount: number
  claimedCount: number
  rewardPaise: number
  referrals: Array<{
    id: string
    status: string
    rewardPaise: number
    createdAt: number
    claimedAt?: number
  }>
}

export interface ProfileStats {
  tradeCount: number
  marketsParticipated: number
  openPositions: number
  resolvedPositions: number
  volumePaise: number
}

export interface SessionUser {
  id: string
  name: string
  phone: string
  avatarColor: string
  isAdmin: boolean
  joinedAt: number
}

export interface MarketFilters {
  category?: string
  query?: string
  sort?: SortKey
  status?: 'live' | 'resolved' | 'all'
  page?: number
  perPage?: number
}

export type SortKey =
  | 'trending'
  | 'volume'
  | 'newest'
  | 'closing'
  | 'probability-high'
  | 'probability-low'

/**
 * Payment layer types.
 *
 * Payment state is intentionally separate from wallet state: a payment can be
 * created, pending, failed or refunded without the wallet moving at all.
 */
export type PaymentMode = 'demo' | 'sandbox' | 'live'

export type {
  PaymentDirection,
  PaymentStatus,
  ProviderStatus,
  ReconciliationStatus,
} from '@/lib/payments/state-machine'

export type RefundStatus = 'none' | 'full' | 'partial'

/** A single payment request and its provider/ledger/reconciliation state. */
export interface PaymentRecord {
  id: string
  userId: string
  userName?: string
  userPhone?: string
  direction: PaymentDirection
  status: PaymentStatus
  mode: PaymentMode
  provider: string
  providerLabel?: string
  providerPaymentId?: string
  providerReference?: string
  providerStatus?: string
  currency: string
  amountPaise: number
  feePaise: number
  netPaise: number
  method?: string
  destination?: string
  transactionId?: string
  parentPaymentId?: string
  refundStatus: RefundStatus
  reconciliationStatus: ReconciliationStatus
  failureCode?: string
  failureReason?: string
  /** Hosted checkout link, so a pending deposit can be resumed. */
  checkoutUrl?: string
  /** Bounded provider status re-check bookkeeping (pending/processing only). */
  recheckAttempts: number
  lastRecheckedAt?: number
  createdAt: number
  updatedAt: number
  settledAt?: number
  /** Admin visibility only: the account state the payment was made from. */
  accountStatus?: 'active' | 'restricted' | 'blocked'
  kycStatus?: 'unverified' | 'pending' | 'verified' | 'rejected'
  liveEligible?: boolean
}

/** A single payment's outcome from a bounded provider status re-check. */
export interface PaymentRecheckOutcome {
  paymentId: string
  outcome:
    | 'settled'
    | 'already_settled'
    | 'still_pending'
    | 'no_provider_record'
    | 'failed'
    | 'flagged'
    | 'ignored'
    | 'provider_unavailable'
    | 'skipped'
  reason?: string
}

export interface PaymentRecheckSummary {
  provider: string
  mode: PaymentMode
  checked: number
  settled: number
  stillPending: number
  flagged: number
  unavailable: number
  outcomes: PaymentRecheckOutcome[]
}

/** Server-side eligibility decision for a payment attempt. */
export type PaymentEligibilityDecision = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'REQUIRES_REVIEW'

export interface PaymentEligibilityResult {
  decision: PaymentEligibilityDecision
  /** Machine code, e.g. PAYMENT_KYC_REQUIRED. Never a provider secret. */
  code?: string
  reason?: string
  /** Jurisdiction the account is registered in, when known. */
  jurisdiction?: string
  /** Mode the decision was made for. */
  mode: PaymentMode
}

/** Client-safe payment configuration: mode, limits and live-gate blockers. */
export interface PaymentModeSummary {
  mode: PaymentMode
  requestedMode: PaymentMode
  liveEnabled: boolean
  liveImplemented: boolean
  blockers: string[]
  providerId: string
  providerLabel: string
  currency: string
  minDepositPaise: number
  maxDepositPaise: number
  minWithdrawalPaise: number
  maxWithdrawalPaise: number
  sandboxReady: boolean
  /** Provider configured for real money and whether its adapter exists. */
  liveProviderId: string
  /** Exact env var names still missing for live money (names only, never values). */
  missingForLive: string[]
  missingForSandbox: string[]
  /** True when a real PSP adapter (not the simulator) is serving this mode. */
  usesRealProvider: boolean
  /**
   * True when this deployment refuses to create new monetary exposure (a
   * production runtime that could not honour its requested payment mode). The UI
   * should disable deposit/withdrawal entry points and explain why.
   */
  mutationBlocked: boolean
  /** Payout source account configured (required before withdrawals can settle). */
  payoutConfigured: boolean
}

export interface PaymentWebhookEventSummary {
  id: string
  provider: string
  providerEventId: string
  eventType: string
  status: 'received' | 'processed' | 'ignored' | 'failed' | 'rejected'
  paymentIntentId?: string
  providerPaymentId?: string
  error?: string
  attempts: number
  receivedAt: number
  processedAt?: number
}

/** One auditable administrative/system financial action, as shown to admins. */
export interface AuditTrailEntry {
  id: string
  actorRole: 'admin' | 'system' | 'provider' | 'user'
  actorUserId?: string
  action: string
  entityType: string
  entityId: string
  summary: string
  createdAt: number
}

export interface ReconciliationFinding {
  id: string
  runId: string
  provider: string
  paymentIntentId: string
  status: ReconciliationStatus
  internalStatus?: PaymentStatus
  providerStatus?: ProviderStatus
  internalAmountPaise?: number
  providerAmountPaise?: number
  notes?: string
  createdAt: number
  resolvedAt?: number
}

/**
 * Result of checking one wallet against its ledger. Read-only: a difference is
 * reported for investigation, never compensated.
 */
export interface WalletLedgerAudit {
  userId: string
  entryCount: number
  ledgerCompletedPaise: number
  ledgerPendingPaise: number
  expectedTotalPaise: number
  walletAvailablePaise: number
  walletLockedPaise: number
  walletBonusPaise: number
  ledgerBonusPaise: number
  actualTotalPaise: number
  differencePaise: number
  bonusDifferencePaise: number
  status: 'matched' | 'difference'
}

export interface ReconciliationRunSummary {
  id: string
  provider: string
  mode: PaymentMode
  status: 'running' | 'completed' | 'failed'
  checkedCount: number
  matchedCount: number
  mismatchCount: number
  notes?: string
  startedAt: number
  finishedAt?: number
  findings: ReconciliationFinding[]
}

export interface AdminTransaction {
  id: string
  reference: string
  type: TransactionType
  amountPaise: number
  status: TransactionStatus
  createdAt: number
  description: string
  userId: string
  userName: string
  userPhone: string
  refundable: boolean
}

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  perPage: number
  hasMore: boolean
}
