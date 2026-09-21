/**
 * Live-money gate.
 *
 * Real money can only be processed when an explicit, environment-level
 * activation control is present AND every legal/compliance/provider
 * prerequisite is confirmed. Merely configuring provider credentials is never
 * enough, and there is deliberately no client flag, hidden URL, admin action or
 * environment trick that flips this gate: it is derived from the process
 * environment only, evaluated server-side on every financial request.
 *
 * The gate fails closed. If anything required is missing we downgrade to
 * SANDBOX (or DEMO) and expose the blockers so operators can see why.
 *
 * Pure module: it takes the environment as an argument and returns a decision.
 */

// Explicit extension so this pure module is also loadable by the Node test
// runner (`tests/payments/*.test.ts`) without a bundler alias resolver.
import { SUPPORTED_CURRENCY } from './limits.ts'

export const PAYMENTS_MODES = ['demo', 'sandbox', 'live'] as const
export type PaymentsMode = (typeof PAYMENTS_MODES)[number]

export const PAYMENTS_ENV = {
  mode: 'PAYMENTS_MODE',
  liveActivation: 'PAYMENTS_LIVE_ACTIVATION',
  complianceAck: 'PAYMENTS_COMPLIANCE_ACK',
  complianceOwner: 'PAYMENTS_COMPLIANCE_OWNER',
  liveJurisdiction: 'PAYMENTS_LIVE_JURISDICTION',
  allowedJurisdictions: 'PAYMENTS_ALLOWED_LIVE_JURISDICTIONS',
  liveProvider: 'PAYMENTS_LIVE_PROVIDER',
  liveApiKey: 'PAYMENTS_LIVE_API_KEY',
  liveApiSecret: 'PAYMENTS_LIVE_API_SECRET',
  webhookSecretDemo: 'PAYMENTS_WEBHOOK_SECRET_DEMO',
  webhookSecretSandbox: 'PAYMENTS_WEBHOOK_SECRET_SANDBOX',
  /** Which adapter serves sandbox mode: `simulated` (default) or `razorpay`. */
  sandboxProvider: 'PAYMENTS_SANDBOX_PROVIDER',
  /** Jurisdictions that must never be allowed to pay, even when allowlisted. */
  blockedJurisdictions: 'PAYMENTS_BLOCKED_JURISDICTIONS',
  /**
   * Explicit operator acknowledgement that a PRODUCTION runtime may move
   * balances through a *simulated* provider (a public demo deployment, never a
   * real-money one). Production refuses simulated balance movement without it.
   */
  allowSimulatedInProduction: 'PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION',
} as const

/**
 * Provider credential variable names. Razorpay uses one key pair per mode:
 * test keys drive sandbox runs, live keys drive real money.
 */
export const RAZORPAY_ENV = {
  testKeyId: 'PAYMENTS_RAZORPAY_TEST_KEY_ID',
  testKeySecret: 'PAYMENTS_RAZORPAY_TEST_KEY_SECRET',
  testWebhookSecret: 'PAYMENTS_RAZORPAY_TEST_WEBHOOK_SECRET',
  liveKeyId: 'PAYMENTS_RAZORPAY_LIVE_KEY_ID',
  liveKeySecret: 'PAYMENTS_RAZORPAY_LIVE_KEY_SECRET',
  liveWebhookSecret: 'PAYMENTS_RAZORPAY_LIVE_WEBHOOK_SECRET',
  /** RazorpayX source account (customer identifier or current account number). */
  payoutAccountNumber: 'PAYMENTS_RAZORPAY_PAYOUT_ACCOUNT_NUMBER',
  /** Payout rail: UPI | IMPS | NEFT | RTGS (default UPI). */
  payoutMode: 'PAYMENTS_RAZORPAY_PAYOUT_MODE',
  /** Create a hosted payment link per deposit instead of returning checkout params. */
  usePaymentLinks: 'PAYMENTS_RAZORPAY_USE_PAYMENT_LINKS',
  /** API base override (staging/local mocks). Defaults to the production API. */
  apiBase: 'PAYMENTS_RAZORPAY_API_BASE',
  /** Merchant/account id expected in provider responses, when available. */
  merchantAccountId: 'PAYMENTS_RAZORPAY_ACCOUNT_ID',
} as const

export type PaymentEnv = Record<string, string | undefined>

export interface LiveGateRequirement {
  key: string
  label: string
  satisfied: boolean
}

export interface LiveGateDecision {
  /** What the environment asked for. */
  requested: PaymentsMode
  /** What the application will actually run as. Never `live` unless fully gated. */
  effective: PaymentsMode
  /** True only when every live prerequisite is satisfied and no blockers remain. */
  liveEnabled: boolean
  currency: string
  /** External (provider + webhook) configuration complete for sandbox. */
  sandboxReady: boolean
  /** True in a production runtime, where a requested mode may never silently degrade. */
  productionStrict: boolean
  /** True when a real (non-simulated) provider serves the effective mode. */
  usesRealProviderAdapter: boolean
  /**
   * True when this deployment must refuse to move balances.
   *
   * Set in production when the requested mode could not be honoured (so the app
   * never quietly runs a weaker payment mode than the operator asked for) or
   * when a simulated provider would move balances without the explicit
   * {@link PAYMENTS_ENV.allowSimulatedInProduction} acknowledgement.
   */
  mutationBlocked: boolean
  /** Reasons live was refused, or sandbox had to fall back to demo. */
  blockers: string[]
  requirements: LiveGateRequirement[]
  complianceOwner?: string
  jurisdiction?: string
  acknowledgements: string[]
}

function truthy(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true'
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

export function normalizePaymentsMode(value: string | undefined): { mode: PaymentsMode; note?: string } {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return { mode: 'demo', note: 'PAYMENTS_MODE was not set, defaulting to demo' }
  if ((PAYMENTS_MODES as readonly string[]).includes(raw)) return { mode: raw as PaymentsMode }
  return { mode: 'demo', note: `PAYMENTS_MODE=${raw} is not a known mode, defaulting to demo` }
}

export function resolvePaymentsMode(input: {
  env: PaymentEnv
  /** A sandbox adapter exists and its webhook signing secret is present. */
  sandboxReady: boolean
  /** A live PSP adapter is implemented in this build. */
  liveProviderImplemented: boolean
  /** Live provider credential env vars are present. */
  liveCredentialsPresent: boolean
  /**
   * The sandbox adapter is the real provider in test mode (Razorpay test keys)
   * rather than the in-process simulator. Optional so pure callers/tests can
   * omit it: absent means "simulated", the conservative reading.
   */
  sandboxUsesRealProvider?: boolean
  nodeEnv: string
}): LiveGateDecision {
  const { env, nodeEnv } = input
  const { mode: requested, note } = normalizePaymentsMode(env[PAYMENTS_ENV.mode])

  const acknowledgements: string[] = []
  if (note) acknowledgements.push(note)

  const jurisdiction = env[PAYMENTS_ENV.liveJurisdiction]?.trim().toLowerCase()
  const allowedJurisdictions = parseList(env[PAYMENTS_ENV.allowedJurisdictions])
  const complianceAck = env[PAYMENTS_ENV.complianceAck]?.trim()
  const complianceOwner = env[PAYMENTS_ENV.complianceOwner]?.trim()
  const activation = truthy(env[PAYMENTS_ENV.liveActivation])

  const requirements: LiveGateRequirement[] = [
    { key: 'runtime', label: 'Production runtime', satisfied: nodeEnv === 'production' },
    { key: 'activation', label: 'Explicit live activation flag', satisfied: activation },
    { key: 'compliance_ack', label: 'Legal classification / compliance acknowledgement', satisfied: Boolean(complianceAck) },
    { key: 'compliance_owner', label: 'Accountable compliance owner', satisfied: Boolean(complianceOwner) },
    {
      key: 'jurisdiction',
      label: 'Jurisdiction approved for live money',
      satisfied: Boolean(jurisdiction) && allowedJurisdictions.includes(jurisdiction ?? ''),
    },
    { key: 'provider_adapter', label: 'Live provider adapter implemented', satisfied: input.liveProviderImplemented },
    { key: 'provider_credentials', label: 'Live provider credentials present', satisfied: input.liveCredentialsPresent },
    { key: 'sandbox_ready', label: 'Sandbox provider + webhook secret configured', satisfied: input.sandboxReady },
  ]

  const blockers: string[] = []
  if (requested === 'live') {
    if (nodeEnv !== 'production') blockers.push('Live money is refused outside a production runtime')
    if (!activation) blockers.push(`${PAYMENTS_ENV.liveActivation} must be exactly "true" — live money requires an explicit operator activation`)
    if (!complianceAck) blockers.push(`${PAYMENTS_ENV.complianceAck} is missing — legal classification and processing compliance are not confirmed`)
    if (!complianceOwner) blockers.push(`${PAYMENTS_ENV.complianceOwner} is missing — no accountable owner recorded`)
    if (!jurisdiction) blockers.push(`${PAYMENTS_ENV.liveJurisdiction} is missing`)
    else if (!allowedJurisdictions.includes(jurisdiction)) {
      blockers.push(`Jurisdiction "${jurisdiction}" is not in ${PAYMENTS_ENV.allowedJurisdictions}`)
    }
    if (!input.liveProviderImplemented) blockers.push('No live payment provider adapter is registered in this build')
    if (!input.liveCredentialsPresent) blockers.push('Live provider credentials are missing from the environment')
  }

  const sandboxBlockers: string[] = []
  if (!input.sandboxReady) {
    sandboxBlockers.push('Sandbox mode requires a sandbox provider adapter and its webhook signing secret')
  }

  let effective: PaymentsMode = requested
  if (requested === 'live' && blockers.length > 0) effective = input.sandboxReady ? 'sandbox' : 'demo'
  else if (requested === 'sandbox' && !input.sandboxReady) effective = 'demo'

  if (effective !== requested) {
    acknowledgements.push(`Requested ${requested} but running ${effective}`)
  }

  const blockedByConfig = requested === 'sandbox' || requested === 'live'

  // -------------------------------------------------------------------------
  // Production posture.
  //
  // Outside production the gate above may degrade freely (a developer asking for
  // live money just gets sandbox/demo). In production a silent degradation is a
  // real-money hazard: a deployment that asked for live but failed a
  // prerequisite would otherwise credit balances through the simulator while
  // users believe they paid. Production therefore refuses to move any balance
  // unless the requested mode was actually honoured AND the provider serving it
  // is a real one, unless the operator explicitly acknowledges a simulated
  // production deployment.
  // -------------------------------------------------------------------------
  const usesRealProviderAdapter =
    effective === 'live' || (effective === 'sandbox' && input.sandboxUsesRealProvider === true)
  const productionStrict = nodeEnv === 'production'
  const simulatedProductionAck = truthy(env[PAYMENTS_ENV.allowSimulatedInProduction])

  const postureNotes: string[] = []
  if (productionStrict) {
    if (effective !== requested) {
      postureNotes.push(
        `Production refuses to fall back from ${requested} to ${effective}: set the ${requested} prerequisites or run ${PAYMENTS_ENV.mode}=${effective} deliberately`,
      )
    }
    if (!usesRealProviderAdapter && !simulatedProductionAck) {
      postureNotes.push(
        `Production refuses to move balances through a simulated provider: serve ${requested} with the real provider, or set ${PAYMENTS_ENV.allowSimulatedInProduction}=true to acknowledge a simulated (non-money) deployment`,
      )
    }
  }
  const mutationBlocked = postureNotes.length > 0
  if (mutationBlocked) {
    blockers.push(...postureNotes)
    acknowledgements.push('Balance-moving payment operations are refused in this deployment')
  }

  return {
    requested,
    effective,
    liveEnabled: requested === 'live' && blockers.length === 0 && effective === 'live',
    currency: SUPPORTED_CURRENCY,
    sandboxReady: input.sandboxReady,
    productionStrict,
    usesRealProviderAdapter,
    mutationBlocked,
    blockers: [...blockers, ...(blockedByConfig ? sandboxBlockers : [])],
    requirements,
    complianceOwner,
    jurisdiction,
    acknowledgements,
  }
}

export function assertLivePaymentsEnabled(decision: LiveGateDecision): void {
  if (!decision.liveEnabled || decision.effective !== 'live') throw new Error('PAYMENTS_LIVE_DISABLED')
}

/** Only these modes may mutate Predik balances; live needs the full gate. */
export function assertModeAllowsBalanceMutation(decision: LiveGateDecision): void {
  if (decision.effective === 'live' && !decision.liveEnabled) throw new Error('PAYMENTS_LIVE_DISABLED')
}

/**
 * Final guard before any NEW monetary exposure is created (deposit, withdrawal,
 * simulated settlement). Combines the live gate with the production posture:
 * a degraded production deployment answers 503 instead of quietly moving money
 * through a mode it was not configured for.
 *
 * Resolving *existing* obligations — webhook settlement of a payment that was
 * already created, and admin refunds of money that already moved — deliberately
 * does NOT call this, so a misconfigured deployment can never strand funds it
 * has already taken in.
 */
export function assertPaymentPosture(decision: LiveGateDecision): void {
  assertModeAllowsBalanceMutation(decision)
  if (decision.mutationBlocked) throw new Error('PAYMENTS_CONFIG_DEGRADED')
}
