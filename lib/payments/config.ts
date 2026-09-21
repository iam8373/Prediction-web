import 'server-only'

import { DEFAULT_LIVE_PROVIDER, isProviderImplemented } from '@/lib/payments/capabilities'
import {
  MAX_DEPOSIT_PAISE,
  MAX_WITHDRAWAL_PAISE,
  MIN_DEPOSIT_PAISE,
  MIN_WITHDRAWAL_PAISE,
  SUPPORTED_CURRENCY,
} from '@/lib/payments/limits'
import {
  PAYMENTS_ENV,
  RAZORPAY_ENV,
  resolvePaymentsMode,
  type LiveGateDecision,
  type PaymentsMode,
} from '@/lib/payments/mode'
import { missingProviderEnv, sandboxProviderId } from '@/lib/payments/provider-credentials'
import type { PaymentModeSummary } from '@/types'

export interface PaymentConfig extends LiveGateDecision {
  nodeEnv: string
  /** Provider adapter serving the effective mode. */
  providerId: string
  providerLabel: string
  /** Provider configured for real money, and whether that adapter exists. */
  liveProviderId: string
  liveProviderImplemented: boolean
  liveCredentialsPresent: boolean
  /** Exact env var names still missing for live money (never the values). */
  liveCredentialsMissing: string[]
  /** Which adapter serves sandbox mode, and what it is still missing. */
  sandboxProviderId: string
  sandboxCredentialsMissing: string[]
  sandboxUsesRealProvider: boolean
  /** Hosted-checkout and payout configuration for the real provider. */
  providerOptions: {
    /** Provider-hosted payment link per deposit (the default collection model). */
    usePaymentLinks: boolean
    payoutAccountConfigured: boolean
    payoutMode: string
    /** Merchant/account id expected in provider responses, when configured. */
    merchantAccountId?: string
  }
  limits: {
    currency: string
    minDepositPaise: number
    maxDepositPaise: number
    minWithdrawalPaise: number
    maxWithdrawalPaise: number
  }
  /** Webhook signing secret lookup for the simulated adapters. */
  webhookSecret: (providerId: string) => string | undefined
}

const PROVIDER_LABELS: Record<string, string> = {
  demo: 'Predik demo provider',
  sandbox: 'Predik sandbox provider',
  razorpay: 'Razorpay',
}

function env(name: string) {
  return process.env[name]?.trim() || undefined
}

function webhookSecretFor(providerId: string) {
  if (providerId === 'demo') return env(PAYMENTS_ENV.webhookSecretDemo)
  if (providerId === 'sandbox') return env(PAYMENTS_ENV.webhookSecretSandbox)
  return env(`PAYMENTS_WEBHOOK_SECRET_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`)
}

let warned = false

/**
 * Resolves the effective payment configuration on every call (cheap, and it
 * means a deployment cannot end up running on a stale mode).
 *
 * The live gate fails closed: anything missing downgrades to sandbox or demo and
 * is reported in `blockers` together with the exact environment variables that
 * are absent. Merely having credentials never enables live money — the explicit
 * activation flag and the compliance prerequisites are required as well.
 */
export function getPaymentConfig(): PaymentConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const liveProviderId = env(PAYMENTS_ENV.liveProvider) ?? DEFAULT_LIVE_PROVIDER
  const liveCredentialsMissing = missingProviderEnv(liveProviderId, 'live')
  const liveProviderImplemented = isProviderImplemented(liveProviderId)
  const sandboxProvider = sandboxProviderId()
  const sandboxCredentialsMissing = sandboxProvider === 'razorpay' ? missingProviderEnv(sandboxProvider, 'sandbox') : []
  const sandboxUsesRealProvider = sandboxProvider === 'razorpay'
  const sandboxReady = sandboxUsesRealProvider
    ? sandboxCredentialsMissing.length === 0
    : Boolean(webhookSecretFor('sandbox'))

  const decision = resolvePaymentsMode({
    env: process.env,
    sandboxReady,
    sandboxUsesRealProvider,
    liveProviderImplemented,
    liveCredentialsPresent: liveCredentialsMissing.length === 0,
    nodeEnv,
  })

  const providerId: string = decision.effective === 'live'
    ? liveProviderId
    : decision.effective === 'demo'
      ? 'demo'
      : sandboxProvider === 'razorpay'
        ? 'razorpay'
        : 'sandbox'

  if (!warned && (decision.blockers.length > 0 || decision.effective !== decision.requested)) {
    warned = true
    console.warn(
      `[payments] running in ${decision.effective.toUpperCase()} mode via ${providerId} (requested ${decision.requested.toUpperCase()}); ` +
        `live money ${decision.liveEnabled ? 'ENABLED' : 'DISABLED'}; ` +
        `balance-moving payments ${decision.mutationBlocked ? 'REFUSED' : 'allowed'}. ` +
        `Reasons: ${decision.blockers.join('; ') || 'none'}`,
    )
  }

  return {
    ...decision,
    nodeEnv,
    providerId,
    providerLabel: PROVIDER_LABELS[providerId] ?? `${providerId} payment provider`,
    liveProviderId,
    liveProviderImplemented,
    liveCredentialsPresent: liveCredentialsMissing.length === 0,
    liveCredentialsMissing,
    sandboxProviderId: sandboxProvider,
    sandboxCredentialsMissing,
    sandboxUsesRealProvider: sandboxProvider === 'razorpay' && sandboxCredentialsMissing.length === 0,
    providerOptions: {
      usePaymentLinks: (env(RAZORPAY_ENV.usePaymentLinks) ?? 'true').toLowerCase() === 'true',
      payoutAccountConfigured: Boolean(env(RAZORPAY_ENV.payoutAccountNumber)),
      payoutMode: (env(RAZORPAY_ENV.payoutMode) ?? 'UPI').toUpperCase(),
      merchantAccountId: env(RAZORPAY_ENV.merchantAccountId),
    },
    limits: {
      currency: SUPPORTED_CURRENCY,
      minDepositPaise: MIN_DEPOSIT_PAISE,
      maxDepositPaise: MAX_DEPOSIT_PAISE,
      minWithdrawalPaise: MIN_WITHDRAWAL_PAISE,
      maxWithdrawalPaise: MAX_WITHDRAWAL_PAISE,
    },
    webhookSecret: webhookSecretFor,
  }
}

/** Client-safe projection: mode, limits, provider and blockers. No secrets, no credentials. */
export function publicPaymentConfig(config: PaymentConfig = getPaymentConfig()): PaymentModeSummary {
  return {
    mode: config.effective as PaymentsMode,
    requestedMode: config.requested,
    liveEnabled: config.liveEnabled,
    liveImplemented: config.liveProviderImplemented,
    blockers: config.blockers,
    providerId: config.providerId,
    providerLabel: config.providerLabel,
    currency: config.limits.currency,
    minDepositPaise: config.limits.minDepositPaise,
    maxDepositPaise: config.limits.maxDepositPaise,
    minWithdrawalPaise: config.limits.minWithdrawalPaise,
    maxWithdrawalPaise: config.limits.maxWithdrawalPaise,
    sandboxReady: config.sandboxReady,
    liveProviderId: config.liveProviderId,
    missingForLive: config.liveProviderId === 'razorpay'
      ? config.liveCredentialsMissing
      : config.liveCredentialsMissing,
    missingForSandbox: config.sandboxCredentialsMissing,
    usesRealProvider: config.usesRealProviderAdapter,
    mutationBlocked: config.mutationBlocked,
    payoutConfigured: config.providerOptions.payoutAccountConfigured,
  }
}

export function isDemoOrSandbox(config: PaymentConfig = getPaymentConfig()): boolean {
  return config.effective === 'demo' || config.effective === 'sandbox'
}
