import 'server-only'

/**
 * Sandbox provider + webhook helpers for the PostgreSQL E2E suites.
 *
 * These drive the REAL webhook path (`handleProviderWebhook` → signature
 * verification → `applyProviderEvent` → wallet/ledger) against the simulated
 * sandbox provider. Nothing here stubs the payment service: only the external
 * PSP is simulated, which is exactly what sandbox mode is for.
 */

import { getSimulatedProvider } from '@/lib/payments/provider'
import { buildSignatureHeader, SIGNATURE_HEADER } from '@/lib/payments/signature'
import type { ProviderStatus } from '@/lib/payments/state-machine'
import { handleProviderWebhook, type WebhookHandlerResult } from '@/lib/payments/webhook'

export const SANDBOX_SECRET = 'predik-test-sandbox-webhook-secret'

/** Puts the process into simulated sandbox mode. Live activation is never touched. */
export function configureSandboxEnv() {
  process.env.PAYMENTS_MODE = 'sandbox'
  process.env.PAYMENTS_SANDBOX_PROVIDER = 'simulated'
  process.env.PAYMENTS_WEBHOOK_SECRET_SANDBOX = SANDBOX_SECRET
  process.env.PAYMENTS_WEBHOOK_SECRET_DEMO = 'predik-test-demo-webhook-secret'
  delete process.env.PAYMENTS_LIVE_ACTIVATION
  delete process.env.PAYMENTS_COMPLIANCE_ACK
  delete process.env.PAYMENTS_COMPLIANCE_OWNER
  delete process.env.PAYMENTS_LIVE_JURISDICTION
  delete process.env.PAYMENTS_ALLOWED_LIVE_JURISDICTIONS
}

export function sandboxProvider() {
  return getSimulatedProvider('sandbox')
}

export interface SandboxEventInput {
  /** Provider event id — the idempotency key. */
  eventId?: string
  type: 'payment.succeeded' | 'payment.failed' | 'payment.expired' | 'payment.processing' | 'payout.succeeded' | 'payout.failed' | 'payout.cancelled' | 'refund.succeeded' | 'refund.failed'
  paymentId: string
  reference?: string
  /**
   * `data.internal_reference`: the association the provider echoes back (our
   * internal payment id). Tests forge it to prove an event naming a DIFFERENT
   * internal payment cannot settle this one.
   */
  internalReference?: string
  amountPaise: number
  currency?: string
  /** Sign the body with this secret instead of the real one (invalid-signature tests). */
  secretOverride?: string
  /** Send the header without a timestamp/digest (missing/malformed signature tests). */
  signatureHeaderOverride?: string
  omitSignature?: boolean
  timestampSeconds?: number
  /** Replace the signed payload after signing, to prove the signature is over the raw body. */
  tamperBodyAfterSigning?: (body: string) => string
}

/**
 * Builds a provider event with a valid signature over the exact bytes sent.
 * Tests that need an invalid delivery override the secret or the header.
 */
export function sandboxEvent(input: SandboxEventInput) {
  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000)
  const payload = {
    id: input.eventId ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
    type: input.type,
    created: timestamp,
    data: {
      payment_id: input.paymentId,
      reference: input.reference ?? input.paymentId,
      status: eventStatus(input.type),
      amount_paise: input.amountPaise,
      currency: input.currency ?? 'INR',
      ...(input.internalReference ? { internal_reference: input.internalReference } : {}),
    },
  }
  let rawBody = JSON.stringify(payload)
  const secret = input.secretOverride ?? SANDBOX_SECRET
  let signature = buildSignatureHeader(secret, rawBody, timestamp)
  if (input.tamperBodyAfterSigning) {
    rawBody = input.tamperBodyAfterSigning(rawBody)
  }
  if (input.signatureHeaderOverride !== undefined) signature = input.signatureHeaderOverride

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (!input.omitSignature) headers[SIGNATURE_HEADER] = signature
  return { rawBody, headers, payload, eventId: payload.id }
}

function eventStatus(type: SandboxEventInput['type']): ProviderStatus {
  switch (type) {
    case 'payment.succeeded':
    case 'payout.succeeded':
    case 'refund.succeeded':
      return 'succeeded'
    case 'payment.expired':
      return 'expired'
    case 'payment.processing':
      return 'processing'
    case 'payout.cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

export function deliverWebhook(event: { rawBody: string; headers: Record<string, string> }, providerId = 'sandbox'): Promise<WebhookHandlerResult> {
  return handleProviderWebhook({ providerId, rawBody: event.rawBody, headers: event.headers })
}

/** Flips the simulated provider's own record and returns a correctly signed delivery. */
export function providerOutcomeWebhook(paymentId: string, outcome: 'succeeded' | 'failed') {
  return sandboxProvider().buildOutcomeWebhook({ paymentId, outcome })
}
