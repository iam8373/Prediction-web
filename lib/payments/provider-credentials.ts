import 'server-only'

import { RAZORPAY_ENV } from '@/lib/payments/mode'

/**
 * Provider credential resolution.
 *
 * Credentials are read from the environment only, per provider *and* per mode,
 * so a sandbox run can never accidentally use live keys, and a live run cannot
 * start without its own key pair and webhook secret.
 *
 * `missingProviderEnv` returns the exact variable names that are absent, which
 * is what the live gate and the admin panel show. Values are never returned to
 * callers other than the provider adapter, never logged, and never serialized.
 */

export type ProviderMode = 'sandbox' | 'live'

export interface ProviderCredentials {
  providerId: string
  mode: ProviderMode
  /** API key id (Basic auth username). */
  keyId: string
  keySecret: string
  /** Every webhook secret that may sign a delivery for this provider/mode. */
  webhookSecrets: string[]
  /** RazorpayX source account, required for payouts. */
  accountNumber?: string
  payoutMode?: string
  usePaymentLinks: boolean
  apiBase?: string
  /** Expected merchant/account id, used to verify provider responses. */
  merchantAccountId?: string
}

function env(name: string) {
  return process.env[name]?.trim() || undefined
}

const RAZORPAY_MODE_ENV: Record<ProviderMode, { keyId: string; keySecret: string; webhookSecret: string }> = {
  sandbox: {
    keyId: RAZORPAY_ENV.testKeyId,
    keySecret: RAZORPAY_ENV.testKeySecret,
    webhookSecret: RAZORPAY_ENV.testWebhookSecret,
  },
  live: {
    keyId: RAZORPAY_ENV.liveKeyId,
    keySecret: RAZORPAY_ENV.liveKeySecret,
    webhookSecret: RAZORPAY_ENV.liveWebhookSecret,
  },
}

/** Env vars that must be present for a provider to operate in a mode. */
export function requiredProviderEnv(providerId: string, mode: ProviderMode): string[] {
  if (providerId !== 'razorpay') return [`PAYMENTS_${providerId.toUpperCase()}_${mode.toUpperCase()}_KEY_ID`]
  const keys = RAZORPAY_MODE_ENV[mode]
  const required = [keys.keyId, keys.keySecret, keys.webhookSecret]
  if (mode === 'live') required.push(RAZORPAY_ENV.payoutAccountNumber)
  return required
}

export function missingProviderEnv(providerId: string, mode: ProviderMode): string[] {
  return requiredProviderEnv(providerId, mode).filter((name) => !env(name))
}

export function isProviderConfigured(providerId: string, mode: ProviderMode): boolean {
  return missingProviderEnv(providerId, mode).length === 0
}

/**
 * Credentials for a provider/mode, or null when the provider is not usable.
 * Both webhook secrets are included so a delivery signed with the previous
 * secret still verifies during a controlled secret rotation or cutover.
 */
export function resolveProviderCredentials(providerId: string, mode: ProviderMode): ProviderCredentials | null {
  if (providerId !== 'razorpay') return null
  if (missingProviderEnv(providerId, mode).length > 0) return null

  const keys = RAZORPAY_MODE_ENV[mode]
  const webhookSecrets = [
    env(keys.webhookSecret),
    // Accept the other mode's secret only when it is also configured: this makes
    // a test->live cutover survivable without ever failing open.
    env(RAZORPAY_MODE_ENV[mode === 'live' ? 'sandbox' : 'live'].webhookSecret),
  ].filter((secret): secret is string => Boolean(secret))

  return {
    providerId,
    mode,
    keyId: env(keys.keyId) as string,
    keySecret: env(keys.keySecret) as string,
    webhookSecrets,
    accountNumber: env(RAZORPAY_ENV.payoutAccountNumber),
    payoutMode: env(RAZORPAY_ENV.payoutMode),
    // Defaults ON: a provider-hosted payment link keeps card/UPI credentials out
    // of Predik entirely, which is the preferred collection model. Setting the
    // variable to "false" switches to the Orders + Checkout.js flow, where the
    // client completes the order that the deposit response returns.
    usePaymentLinks: (env(RAZORPAY_ENV.usePaymentLinks) ?? 'true').toLowerCase() === 'true',
    apiBase: env(RAZORPAY_ENV.apiBase),
    merchantAccountId: env(RAZORPAY_ENV.merchantAccountId),
  }
}

/** Which adapter serves sandbox mode: the real PSP test mode, or the simulator. */
export function sandboxProviderId(): 'simulated' | string {
  const configured = (env('PAYMENTS_SANDBOX_PROVIDER') ?? 'simulated').toLowerCase()
  return configured === 'razorpay' ? 'razorpay' : 'simulated'
}
