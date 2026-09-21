/**
 * Canonical payment state machines.
 *
 * A payment request is NOT a wallet credit. The payment lifecycle below is
 * deliberately separate from the wallet/ledger lifecycle, and only the
 * `verified -> completed` step moves money. Every transition is validated by
 * `assertPaymentTransition` before a financial mutation is allowed.
 *
 * Pure module: no database, no environment, no `server-only` — it is imported
 * by the API layer and directly unit tested.
 */

export const PAYMENT_STATUSES = [
  'created', // internal payment row written, provider not yet called/answered
  'pending', // provider payment exists, awaiting confirmation
  'processing', // provider is settling (payout in flight for withdrawals)
  'verified', // provider confirmed success, authenticity + amount validated
  'completed', // wallet + ledger + transaction written (terminal)
  'failed', // provider or validation failure (terminal)
  'cancelled', // cancelled before settlement (terminal)
  'expired', // provider window elapsed (terminal)
  'refunded', // fully reversed after settlement (terminal)
  'partially_refunded', // reserved for a future partial-refund model
] as const

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export type PaymentDirection = 'deposit' | 'withdrawal' | 'refund'

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['pending', 'processing', 'verified', 'failed', 'cancelled', 'expired'],
  pending: ['processing', 'verified', 'failed', 'cancelled', 'expired'],
  processing: ['verified', 'completed', 'failed', 'cancelled', 'expired'],
  verified: ['completed', 'failed', 'refunded'],
  completed: ['refunded', 'partially_refunded'],
  failed: [],
  cancelled: [],
  expired: [],
  refunded: [],
  partially_refunded: ['refunded'],
}

export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'failed',
  'cancelled',
  'expired',
  'refunded',
]

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true
  return PAYMENT_TRANSITIONS[from].includes(to)
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new Error('INVALID_PAYMENT_TRANSITION')
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status)
}

/** True when the wallet/ledger has already been mutated for this payment. */
export function isSettledPaymentStatus(status: PaymentStatus): boolean {
  return status === 'completed' || status === 'refunded' || status === 'partially_refunded'
}

/**
 * Maps a payment status onto the pre-existing `transaction.status` vocabulary
 * so user-facing history keeps working without a schema change.
 */
export function toTransactionStatus(status: PaymentStatus): 'pending' | 'completed' | 'failed' {
  if (status === 'completed' || status === 'refunded' || status === 'partially_refunded') return 'completed'
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return 'failed'
  return 'pending'
}

/** Statuses reported by a payment provider over its API / webhooks. */
export const PROVIDER_STATUSES = [
  'created',
  'pending',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'refunded',
  'partially_refunded',
] as const

export type ProviderStatus = (typeof PROVIDER_STATUSES)[number]

/**
 * Maps a provider status onto the internal payment status it implies.
 * Used by reconciliation to compare internal truth against provider truth.
 */
export function providerStatusToPaymentStatus(status: ProviderStatus): PaymentStatus {
  switch (status) {
    case 'created':
      return 'created'
    case 'pending':
      return 'pending'
    case 'processing':
      return 'processing'
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'expired':
      return 'expired'
    case 'refunded':
      return 'refunded'
    case 'partially_refunded':
      return 'partially_refunded'
  }
}

/** Provider statuses that let the service advance a payment without a webhook. */
export function isProviderSettlementFinal(status: ProviderStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired'
}

export const RECONCILIATION_STATUSES = [
  'unchecked',
  'matched',
  'mismatch',
  'missing_provider_record',
  'missing_internal_record',
  'status_mismatch',
  'amount_mismatch',
  'currency_mismatch',
  'not_checkable',
] as const

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number]

export interface ReconciliationComparison {
  status: ReconciliationStatus
  notes: string
}

export interface ComparablePayment {
  status: PaymentStatus
  amountPaise: number
  currency: string
  providerStatus?: string | null
}

/**
 * Compares our internal payment record against the provider's record.
 * Never mutates anything and never guesses a correction — a mismatch is
 * surfaced for controlled handling.
 */
export function comparePaymentRecords(
  internal: ComparablePayment,
  provider: { status: ProviderStatus; amountPaise: number; currency: string } | null,
): ReconciliationComparison {
  if (!provider) {
    return { status: 'missing_provider_record', notes: 'The provider has no record of this payment' }
  }
  if (provider.currency !== internal.currency) {
    return {
      status: 'currency_mismatch',
      notes: `Internal currency ${internal.currency} but provider reported ${provider.currency}`,
    }
  }
  if (provider.amountPaise !== internal.amountPaise) {
    return {
      status: 'amount_mismatch',
      notes: `Internal amount ${internal.amountPaise} paise but provider reported ${provider.amountPaise} paise`,
    }
  }
  const expected = providerStatusToPaymentStatus(provider.status)
  if (expected === internal.status) return { status: 'matched', notes: '' }
  if (internal.status === 'verified' && expected === 'completed') {
    return {
      status: 'mismatch',
      notes: 'Provider succeeded but the wallet/ledger settlement did not complete — needs controlled settlement',
    }
  }
  if (internal.status === 'created' && expected === 'pending') {
    return { status: 'mismatch', notes: 'Provider payment exists but the internal record never advanced past created' }
  }
  // Both sides say "not settled yet": the payment is simply still in flight, not
  // inconsistent. Without this an unpaid provider order (deposits via a hosted
  // order/link are pending until capture) would be reported as a mismatch on
  // every reconciliation run and bury the real divergences.
  const OPEN_INTERNAL: readonly PaymentStatus[] = ['pending', 'processing']
  const OPEN_PROVIDER: readonly ProviderStatus[] = ['created', 'pending', 'processing']
  if (OPEN_INTERNAL.includes(internal.status) && OPEN_PROVIDER.includes(provider.status)) {
    return { status: 'matched', notes: '' }
  }
  return {
    status: 'status_mismatch',
    notes: `Internal status ${internal.status} but provider status ${provider.status} implies ${expected}`,
  }
}

/** Human label used in the wallet, admin tables and notifications. */
export function describePaymentStatus(status: PaymentStatus): string {
  switch (status) {
    case 'created':
      return 'Created'
    case 'pending':
      return 'Pending'
    case 'processing':
      return 'Processing'
    case 'verified':
      return 'Confirmed — settling'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'expired':
      return 'Expired'
    case 'refunded':
      return 'Refunded'
    case 'partially_refunded':
      return 'Partially refunded'
  }
}
