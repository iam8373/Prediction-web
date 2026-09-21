/**
 * Coded payment errors mapped to HTTP responses.
 *
 * The payment service throws short codes (so they are easy to assert on and
 * never leak provider detail); this table is the single place that decides what
 * the API returns for them. Framework-free on purpose.
 */

export interface PaymentErrorResponse {
  status: number
  error: string
}

export const PAYMENT_ERROR_MAP: Record<string, PaymentErrorResponse> = {
  PAYMENT_AMOUNT_INVALID: { status: 400, error: 'The payment amount must be a whole number of paise' },
  DEPOSIT_BELOW_MINIMUM: { status: 400, error: 'Minimum deposit is ₹100' },
  DEPOSIT_ABOVE_MAXIMUM: { status: 400, error: 'Maximum deposit is ₹2,00,000' },
  WITHDRAWAL_BELOW_MINIMUM: { status: 400, error: 'Minimum withdrawal is ₹200' },
  WITHDRAWAL_ABOVE_MAXIMUM: { status: 400, error: 'Maximum withdrawal is ₹2,00,000' },
  UNSUPPORTED_CURRENCY: { status: 400, error: 'Predik only settles INR right now' },
  PAYMENT_PROVIDER_ERROR: { status: 502, error: 'The payment provider could not be reached' },
  PAYMENTS_LIVE_DISABLED: { status: 503, error: 'Live payments are disabled. Predik is running in a non-live payment mode.' },
  PROVIDER_NOT_CONFIGURED: { status: 503, error: 'Payments are not configured for this environment yet' },
  PAYMENTS_CONFIG_DEGRADED: {
    status: 503,
    error: 'Payments are temporarily unavailable on this deployment. No money has moved — please try again later or contact support.',
  },
  SANDBOX_NOT_ACTIVE: { status: 409, error: 'Sandbox simulation is only available in sandbox mode' },
  PROVIDER_UNKNOWN: { status: 503, error: 'That payment provider is not available in this environment' },
  ACCOUNT_NOT_READY: { status: 409, error: 'Your wallet is not ready yet. Try again.' },
  INSUFFICIENT_BALANCE: { status: 409, error: 'Withdrawal exceeds your available balance' },
  PAYMENT_ACCOUNT_BLOCKED: { status: 403, error: 'Payments are blocked on this account. Contact support.' },
  PAYMENT_ACCOUNT_RESTRICTED: { status: 403, error: 'Withdrawals are restricted on this account. Contact support.' },
  PAYMENT_KYC_REQUIRED: { status: 403, error: 'Complete identity verification before moving real money' },
  PAYMENT_KYC_PENDING: { status: 403, error: 'Your identity verification is still being processed' },
  PAYMENT_KYC_REJECTED: { status: 403, error: 'Your identity verification was not successful. Contact support.' },
  PAYMENT_NOT_ELIGIBLE: { status: 403, error: 'This account is not eligible for that payment' },
  PAYMENT_LIVE_NOT_ELIGIBLE: { status: 403, error: 'This account is not approved for real-money payments' },
  PAYMENT_JURISDICTION_UNKNOWN: { status: 403, error: 'Your jurisdiction has not been approved for real-money payments' },
  PAYMENT_JURISDICTION_MISMATCH: { status: 403, error: 'This account is registered in another jurisdiction' },
  PAYMENT_NOT_FOUND: { status: 404, error: 'Payment not found' },
  PAYMENT_DIRECTION_MISMATCH: { status: 409, error: 'That payment cannot be handled this way' },
  PAYMENT_ALREADY_FINAL: { status: 409, error: 'That payment has already reached its final state' },
  PAYMENT_STATE_CONFLICT: { status: 409, error: 'The payment changed while we were working on it. Refresh and try again.' },
  INVALID_PAYMENT_TRANSITION: { status: 409, error: 'That payment is not in a state where this is allowed' },
  PAYMENT_AMOUNT_MISMATCH: { status: 409, error: 'The provider confirmed a different amount than requested' },
  PAYMENT_CURRENCY_MISMATCH: { status: 409, error: 'The provider confirmed a different currency than requested' },
  PAYMENT_REFERENCE_MISMATCH: { status: 409, error: 'The provider result does not belong to this payment' },
  PAYMENT_ACCOUNT_MISMATCH: { status: 409, error: 'The provider result belongs to a different merchant account' },
  PROVIDER_TIMEOUT: { status: 504, error: 'The payment provider did not respond in time. We are still confirming this payment.' },
  PROVIDER_UNAVAILABLE: { status: 503, error: 'The payment provider is unavailable right now. We are still confirming this payment.' },
  PROVIDER_BAD_RESPONSE: { status: 502, error: 'The payment provider returned an unexpected response' },
  PAYMENT_UNDER_REVIEW: { status: 403, error: 'This payment needs a compliance review before it can continue' },
  PAYMENT_JURISDICTION_BLOCKED: { status: 403, error: 'Payments are not available in your jurisdiction' },
  PAYMENT_DIRECTION_UNSUPPORTED: { status: 409, error: 'That payment type is not enabled for this account' },
  LOCK_MISMATCH: { status: 409, error: 'The locked balance no longer matches this withdrawal. Refresh and try again.' },
  UNKNOWN_TRANSACTION: { status: 404, error: 'Transaction not found' },
  NOT_REFUNDABLE: { status: 409, error: 'This transaction cannot be refunded' },
  REFUND_FAILED: { status: 502, error: 'The refund could not be confirmed' },
  PROVIDER_PAYMENT_MISSING: { status: 409, error: 'This payment has no provider reference yet' },
  PROVIDER_NOT_SETTLED: { status: 409, error: 'The provider has not reported this payout as successful' },
  RECONCILIATION_PROVIDER_UNAVAILABLE: { status: 503, error: 'That provider is not available for reconciliation here' },
  INVALID_IDEMPOTENCY_KEY: { status: 400, error: 'The idempotency key is invalid' },
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    error: 'That request was already submitted for a different amount. Start a new request.',
  },
}

export function describePaymentError(error: unknown): PaymentErrorResponse | null {
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return PAYMENT_ERROR_MAP[code] ?? null
}
