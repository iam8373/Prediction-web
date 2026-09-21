import 'server-only'

import { DEFAULT_LIVE_PROVIDER, isProviderImplemented } from '@/lib/payments/capabilities'
import { getPaymentConfig, type PaymentConfig } from '@/lib/payments/config'
import type { PaymentsMode } from '@/lib/payments/mode'
import { PaymentProviderError, type PaymentProvider } from '@/lib/payments/contracts'
import { sandboxProviderId, resolveProviderCredentials, type ProviderMode } from '@/lib/payments/provider-credentials'
import { RazorpayPaymentProvider } from '@/lib/payments/razorpay/provider'
import { defaultFailureTrigger, SimulatedPaymentProvider } from '@/lib/payments/simulated-provider'

/**
 * Payment provider registry.
 *
 * Providers are selected from configuration and never imported directly by
 * callers, so exactly one place decides which gateway is active and no code path
 * can reach a live gateway the gate has not enabled.
 *
 * Simulated adapters keep their ledger in memory, so the registry hands out the
 * same instance per id (otherwise a webhook or reconciliation run would inspect
 * an empty provider). Real adapters are stateless and cheap to build.
 */

export type {
  PaymentProvider,
  PaymentProviderCapabilities,
  ProviderPaymentRecord,
  ProviderWebhookEvent,
  SimulatedProviderOptions,
  WebhookVerification,
} from '@/lib/payments/contracts'
export { PaymentProviderError } from '@/lib/payments/contracts'

const simulatedCache = new Map<string, { secret: string | undefined; provider: SimulatedPaymentProvider }>()

function buildSimulatedProvider(id: 'demo' | 'sandbox', config: PaymentConfig): SimulatedPaymentProvider {
  if (id === 'demo') {
    return new SimulatedPaymentProvider({
      id: 'demo',
      label: 'Predik demo provider',
      mode: 'demo',
      settlement: 'instant',
      webhookSecret: config.webhookSecret('demo'),
      // The demo provider never fails: demo balances are not real money and the
      // failure paths are exercised through the sandbox provider instead.
      failureTrigger: () => false,
    })
  }

  const secret = config.webhookSecret('sandbox')
  if (!secret) {
    throw new PaymentProviderError(
      'PROVIDER_NOT_CONFIGURED',
      'Simulated sandbox mode needs PAYMENTS_WEBHOOK_SECRET_SANDBOX before payments can be created',
    )
  }
  return new SimulatedPaymentProvider({
    id: 'sandbox',
    label: 'Predik sandbox provider',
    mode: 'sandbox',
    settlement: 'async',
    webhookSecret: secret,
    failureTrigger: defaultFailureTrigger,
  })
}

export function getSimulatedProvider(id: 'demo' | 'sandbox', config: PaymentConfig = getPaymentConfig()) {
  const secret = config.webhookSecret(id)
  const cached = simulatedCache.get(id)
  if (cached && cached.secret === secret) return cached.provider
  const provider = buildSimulatedProvider(id, config)
  simulatedCache.set(id, { secret, provider })
  return provider
}

/** Used by the admin sandbox simulator. Typed so callers can build signed events. */
export function getSandboxProvider(): SimulatedPaymentProvider {
  const config = getPaymentConfig()
  if (config.effective !== 'sandbox') {
    throw new PaymentProviderError(
      'SANDBOX_NOT_ACTIVE',
      `Sandbox simulation is unavailable while running in ${config.effective} mode`,
    )
  }
  if (config.providerId !== 'sandbox') {
    throw new PaymentProviderError(
      'SANDBOX_NOT_ACTIVE',
      `Sandbox is running against ${config.providerId}, so only real provider test-mode events can settle payments`,
    )
  }
  return getSimulatedProvider('sandbox', config)
}

/** Real (non-simulated) adapter for a provider/mode, or null when unconfigured. */
export function getRealProvider(providerId: string, mode: ProviderMode): PaymentProvider | null {
  if (providerId !== 'razorpay') return null
  const credentials = resolveProviderCredentials(providerId, mode)
  if (!credentials) return null
  return new RazorpayPaymentProvider(credentials, mode)
}

/** Provider id that will serve a given mode, from configuration alone. */
export function providerIdForMode(mode: PaymentsMode, config: PaymentConfig = getPaymentConfig()): string {
  if (mode === 'live') return config.liveProviderId || DEFAULT_LIVE_PROVIDER
  if (mode === 'demo') return 'demo'
  return sandboxProviderId() === 'razorpay' ? 'razorpay' : 'sandbox'
}

/** The provider for the mode the deployment is actually running in. */
export function getPaymentProvider(mode?: PaymentsMode): PaymentProvider {
  const config = getPaymentConfig()
  const target = mode ?? config.effective

  if (target === 'live') {
    const providerId = config.liveProviderId || DEFAULT_LIVE_PROVIDER
    if (!config.liveEnabled) {
      throw new PaymentProviderError(
        'PAYMENTS_LIVE_DISABLED',
        `Live money is disabled. Unmet prerequisites: ${config.blockers.join('; ') || 'live gate not satisfied'}`,
      )
    }
    const provider = getRealProvider(providerId, 'live')
    if (!provider) {
      throw new PaymentProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `Live provider "${providerId}" is missing configuration: ${config.liveCredentialsMissing.join(', ') || 'unknown'}`,
      )
    }
    return provider
  }

  if (target === 'sandbox') {
    const providerId = providerIdForMode('sandbox', config)
    if (providerId === 'razorpay') {
      const provider = getRealProvider('razorpay', 'sandbox')
      if (provider) return provider
      throw new PaymentProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `Sandbox is configured for razorpay test mode but is missing: ${config.sandboxCredentialsMissing.join(', ')}`,
      )
    }
    return getSimulatedProvider('sandbox', config)
  }

  return getSimulatedProvider('demo', config)
}

/**
 * Look up the provider a historical payment was created against. The payment's
 * own mode decides which credentials are used, so replaying a sandbox payment
 * always talks to the provider's test mode and never to live accounts.
 */
export function getProviderById(providerId: string, mode?: PaymentsMode): PaymentProvider | null {
  const config = getPaymentConfig()
  if (providerId === 'demo') return getSimulatedProvider('demo', config)
  if (providerId === 'sandbox') return getSimulatedProvider('sandbox', config)
  if (!isProviderImplemented(providerId)) return null

  if (mode === 'live') return getRealProvider(providerId, 'live')
  if (mode === 'demo') return null
  if (mode === 'sandbox') return getRealProvider(providerId, 'sandbox')

  // Mode unknown (inbound webhook before the payment is loaded): prefer live
  // credentials, fall back to test credentials. Both modes' webhook secrets are
  // accepted by the adapter, so authenticity is still enforced.
  return getRealProvider(providerId, 'live') ?? getRealProvider(providerId, 'sandbox')
}

export function listRegisteredProviders() {
  const config = getPaymentConfig()
  const rows = [
    { id: 'demo', label: 'Predik demo provider', mode: 'demo' as PaymentsMode, asyncSettlement: false },
    {
      id: 'sandbox',
      label: sandboxProviderId() === 'razorpay' ? 'Razorpay (test mode)' : 'Predik sandbox provider',
      mode: 'sandbox' as PaymentsMode,
      asyncSettlement: true,
    },
  ]
  if (isProviderImplemented('razorpay')) {
    rows.push({ id: 'razorpay', label: 'Razorpay (live)', mode: 'live' as PaymentsMode, asyncSettlement: true })
  }
  return rows.filter((provider) => provider.mode !== 'sandbox' || config.sandboxReady)
}
