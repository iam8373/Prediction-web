import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertLivePaymentsEnabled,
  assertModeAllowsBalanceMutation,
  assertPaymentPosture,
  normalizePaymentsMode,
  resolvePaymentsMode,
  type PaymentEnv,
} from '../../lib/payments/mode.ts'

/** Everything a real-money deployment would need to satisfy. */
const FULLY_CONFIGURED: PaymentEnv = {
  PAYMENTS_MODE: 'live',
  PAYMENTS_LIVE_ACTIVATION: 'true',
  PAYMENTS_COMPLIANCE_ACK: '2026-09-01/legal-review-42',
  PAYMENTS_COMPLIANCE_OWNER: 'compliance@predik.example',
  PAYMENTS_LIVE_JURISDICTION: 'in',
  PAYMENTS_ALLOWED_LIVE_JURISDICTIONS: 'in,mh',
  PAYMENTS_LIVE_PROVIDER: 'acme-psp',
  PAYMENTS_LIVE_API_KEY: 'present',
  PAYMENTS_LIVE_API_SECRET: 'present',
}

function resolve(env: PaymentEnv, overrides: Partial<Parameters<typeof resolvePaymentsMode>[0]> = {}) {
  return resolvePaymentsMode({
    env,
    sandboxReady: true,
    liveProviderImplemented: true,
    liveCredentialsPresent: true,
    nodeEnv: 'production',
    ...overrides,
  })
}

describe('payments mode resolver', () => {
  it('defaults to demo when PAYMENTS_MODE is absent', () => {
    const decision = resolve({})
    assert.equal(decision.requested, 'demo')
    assert.equal(decision.effective, 'demo')
    assert.equal(decision.liveEnabled, false)
  })

  it('falls back to demo for an unknown mode instead of guessing', () => {
    const decision = resolve({ PAYMENTS_MODE: 'production' })
    assert.equal(decision.requested, 'demo')
    assert.equal(decision.effective, 'demo')
    assert.ok(decision.acknowledgements.some((note) => note.includes('not a known mode')))
  })

  it('runs sandbox when sandbox is configured', () => {
    const decision = resolve({ PAYMENTS_MODE: 'sandbox' })
    assert.equal(decision.effective, 'sandbox')
    assert.equal(decision.liveEnabled, false)
  })

  it('refuses sandbox (and downgrades to demo) without a webhook secret', () => {
    const decision = resolve({ PAYMENTS_MODE: 'sandbox' }, { sandboxReady: false })
    assert.equal(decision.effective, 'demo')
    assert.ok(decision.blockers.some((blocker) => blocker.includes('webhook signing secret')))
  })

  it('enables live money only when every prerequisite is confirmed', () => {
    const decision = resolve(FULLY_CONFIGURED)
    assert.equal(decision.requested, 'live')
    assert.equal(decision.effective, 'live')
    assert.equal(decision.liveEnabled, true)
    assert.deepEqual(decision.blockers, [])
  })

  it('never enables live money just because provider credentials exist', () => {
    const decision = resolve({ PAYMENTS_MODE: 'live', PAYMENTS_LIVE_API_KEY: 'present', PAYMENTS_LIVE_API_SECRET: 'present' })
    assert.equal(decision.liveEnabled, false)
    assert.notEqual(decision.effective, 'live')
    assert.equal(decision.effective, 'sandbox')
  })

  it('refuses live money when the explicit activation flag is missing', () => {
    const env = { ...FULLY_CONFIGURED }
    delete env.PAYMENTS_LIVE_ACTIVATION
    const decision = resolve(env)
    assert.equal(decision.liveEnabled, false)
    assert.ok(decision.blockers.some((blocker) => blocker.includes('PAYMENTS_LIVE_ACTIVATION')))
  })

  it('refuses live money when activation is set to anything but "true"', () => {
    for (const value of ['1', 'yes', 'TRUE!', 'on', '']) {
      const decision = resolve({ ...FULLY_CONFIGURED, PAYMENTS_LIVE_ACTIVATION: value })
      assert.equal(decision.liveEnabled, false, `activation "${value}" must not enable live money`)
    }
  })

  it('refuses live money without a compliance acknowledgement and owner', () => {
    const env = { ...FULLY_CONFIGURED }
    delete env.PAYMENTS_COMPLIANCE_ACK
    assert.equal(resolve(env).liveEnabled, false)
    const other = { ...FULLY_CONFIGURED }
    delete other.PAYMENTS_COMPLIANCE_OWNER
    assert.equal(resolve(other).liveEnabled, false)
  })

  it('refuses live money in a jurisdiction that is not allowlisted', () => {
    const decision = resolve({ ...FULLY_CONFIGURED, PAYMENTS_LIVE_JURISDICTION: 'us' })
    assert.equal(decision.liveEnabled, false)
    assert.ok(decision.blockers.some((blocker) => blocker.includes('not in PAYMENTS_ALLOWED_LIVE_JURISDICTIONS')))
  })

  it('refuses live money outside a production runtime', () => {
    const decision = resolve(FULLY_CONFIGURED, { nodeEnv: 'development' })
    assert.equal(decision.liveEnabled, false)
    assert.ok(decision.blockers.some((blocker) => blocker.includes('production runtime')))
  })

  it('refuses live money when the adapter is not implemented or credentials are absent', () => {
    assert.equal(resolve(FULLY_CONFIGURED, { liveProviderImplemented: false }).liveEnabled, false)
    assert.equal(resolve(FULLY_CONFIGURED, { liveCredentialsPresent: false }).liveEnabled, false)
  })

  it('reports each prerequisite so operators can see what is missing', () => {
    const decision = resolve({ PAYMENTS_MODE: 'live' })
    const unmet = decision.requirements.filter((requirement) => !requirement.satisfied).map((requirement) => requirement.key)
    assert.ok(unmet.includes('activation'))
    assert.ok(unmet.includes('compliance_ack'))
    assert.ok(unmet.includes('compliance_owner'))
    assert.ok(unmet.includes('jurisdiction'))
    // The build-time and credential prerequisites are reported the same way.
    const withoutAdapter = resolve({ PAYMENTS_MODE: 'live' }, { liveProviderImplemented: false, liveCredentialsPresent: false })
    const unmetHere = withoutAdapter.requirements.filter((requirement) => !requirement.satisfied).map((requirement) => requirement.key)
    assert.ok(unmetHere.includes('provider_adapter'))
    assert.ok(unmetHere.includes('provider_credentials'))
  })

  it('exposes currency and an auditable owner when configured', () => {
    const decision = resolve(FULLY_CONFIGURED)
    assert.equal(decision.currency, 'INR')
    assert.equal(decision.complianceOwner, 'compliance@predik.example')
    assert.equal(decision.jurisdiction, 'in')
  })
})

describe('live gate assertions', () => {
  it('throws when live money is not fully enabled', () => {
    const decision = resolve({ PAYMENTS_MODE: 'sandbox' })
    assert.throws(() => assertLivePaymentsEnabled(decision), /PAYMENTS_LIVE_DISABLED/)
    assert.throws(() => assertModeAllowsBalanceMutation({ ...decision, effective: 'live' }), /PAYMENTS_LIVE_DISABLED/)
  })

  it('allows balance mutation in demo and sandbox modes', () => {
    assert.doesNotThrow(() => assertModeAllowsBalanceMutation(resolve({ PAYMENTS_MODE: 'demo' })))
    assert.doesNotThrow(() => assertModeAllowsBalanceMutation(resolve({ PAYMENTS_MODE: 'sandbox' })))
  })

  it('does not throw for a fully gated live deployment', () => {
    assert.doesNotThrow(() => assertLivePaymentsEnabled(resolve(FULLY_CONFIGURED)))
  })
})

describe('production posture (no silent degradation)', () => {
  it('refuses to move balances when a requested paid mode cannot be honoured', () => {
    // Asked for live money, gate unmet: previously this silently ran sandbox and
    // would have credited balances while users believed they had paid.
    const decision = resolve({ PAYMENTS_MODE: 'live' })
    assert.equal(decision.effective, 'sandbox')
    assert.equal(decision.productionStrict, true)
    assert.equal(decision.mutationBlocked, true)
    assert.ok(decision.blockers.some((blocker) => blocker.includes('refuses to fall back')))
    assert.throws(() => assertPaymentPosture(decision), /PAYMENTS_CONFIG_DEGRADED/)
  })

  it('refuses simulated balances in production unless explicitly acknowledged', () => {
    const withoutAck = resolve({ PAYMENTS_MODE: 'demo' })
    assert.equal(withoutAck.mutationBlocked, true)
    assert.throws(() => assertPaymentPosture(withoutAck), /PAYMENTS_CONFIG_DEGRADED/)

    const withAck = resolve({ PAYMENTS_MODE: 'demo', PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION: 'true' })
    assert.equal(withAck.mutationBlocked, false)
    assert.doesNotThrow(() => assertPaymentPosture(withAck))
  })

  it('hands the sandbox simulator no money in production', () => {
    const decision = resolve({ PAYMENTS_MODE: 'sandbox' }, { sandboxUsesRealProvider: false })
    assert.equal(decision.effective, 'sandbox')
    assert.equal(decision.usesRealProviderAdapter, false)
    assert.equal(decision.mutationBlocked, true)
    assert.throws(() => assertPaymentPosture(decision), /PAYMENTS_CONFIG_DEGRADED/)
  })

  it('allows a production sandbox served by the real provider in test mode', () => {
    const decision = resolve({ PAYMENTS_MODE: 'sandbox' }, { sandboxUsesRealProvider: true })
    assert.equal(decision.effective, 'sandbox')
    assert.equal(decision.usesRealProviderAdapter, true)
    assert.equal(decision.mutationBlocked, false)
    assert.doesNotThrow(() => assertPaymentPosture(decision))
  })

  it('never blocks a fully gated live deployment', () => {
    const decision = resolve(FULLY_CONFIGURED)
    assert.equal(decision.liveEnabled, true)
    assert.equal(decision.mutationBlocked, false)
    assert.doesNotThrow(() => assertPaymentPosture(decision))
  })

  it('applies only to production: development may still degrade', () => {
    const decision = resolve({ PAYMENTS_MODE: 'live' }, { nodeEnv: 'development' })
    assert.equal(decision.productionStrict, false)
    assert.equal(decision.mutationBlocked, false)
    assert.doesNotThrow(() => assertPaymentPosture(decision))
  })

  it('reports the posture in the decision operators read', () => {
    const decision = resolve({ PAYMENTS_MODE: 'live' })
    assert.ok(decision.acknowledgements.some((note) => note.includes('refused')))
    assert.ok(decision.blockers.some((blocker) => blocker.includes('PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION')))
  })
})

describe('mode normalisation', () => {
  it('accepts the three supported modes case-insensitively', () => {
    assert.equal(normalizePaymentsMode('DEMO').mode, 'demo')
    assert.equal(normalizePaymentsMode(' Sandbox ').mode, 'sandbox')
    assert.equal(normalizePaymentsMode('live').mode, 'live')
  })

  it('defaults to demo when unset', () => {
    assert.equal(normalizePaymentsMode(undefined).mode, 'demo')
  })
})
