/**
 * Build-time facts about the payment adapters compiled into this deployment.
 *
 * Kept in its own module so the (pure) configuration resolver can reason about
 * readiness without importing the provider registry, which itself depends on
 * configuration.
 */

/** Provider ids backed by the simulated adapter. */
export const SIMULATED_PROVIDER_IDS = ['demo', 'sandbox'] as const

/** Provider ids that have a real adapter compiled into this build. */
export const IMPLEMENTED_PROVIDER_IDS = ['demo', 'sandbox', 'razorpay'] as const

/** Default PSP used for live money and for real test-mode sandbox runs. */
export const DEFAULT_LIVE_PROVIDER = 'razorpay'

export function isProviderImplemented(providerId: string): boolean {
  return (IMPLEMENTED_PROVIDER_IDS as readonly string[]).includes(providerId)
}

/**
 * Live balance mutation requires every one of these live requirements. The
 * provider-specific credential names are resolved by
 * `lib/payments/provider-credentials.ts`, which reports exactly which variable
 * is missing instead of just failing.
 */
export const LIVE_GATE_ENV_VARS = [
  'PAYMENTS_MODE=live',
  'PAYMENTS_LIVE_ACTIVATION=true',
  'PAYMENTS_COMPLIANCE_ACK=<version or classification reference>',
  'PAYMENTS_COMPLIANCE_OWNER=<accountable person or team>',
  'PAYMENTS_LIVE_JURISDICTION=<jurisdiction>',
  'PAYMENTS_ALLOWED_LIVE_JURISDICTIONS=<comma separated allowlist>',
  'PAYMENTS_LIVE_PROVIDER=razorpay',
  'PAYMENTS_RAZORPAY_LIVE_KEY_ID / PAYMENTS_RAZORPAY_LIVE_KEY_SECRET',
  'PAYMENTS_RAZORPAY_LIVE_WEBHOOK_SECRET',
  'PAYMENTS_RAZORPAY_PAYOUT_ACCOUNT_NUMBER',
] as const
