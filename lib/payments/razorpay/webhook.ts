/**
 * Razorpay webhook authenticity.
 *
 * Razorpay signs the raw request body with the webhook secret and sends the
 * HMAC-SHA256 hex digest in `X-Razorpay-Signature`. The unique event id travels
 * in `X-Razorpay-event-id` and is the idempotency key for the delivery (duplicate
 * deliveries are expected by design, and events may arrive out of order).
 *
 * The signature itself carries no timestamp, so replay protection comes from the
 * stored unique provider event id rather than from a clock window.
 */

import type { WebhookVerification } from '@/lib/payments/contracts'
import { verifyBodySignature } from '@/lib/payments/signature'

import { mapEventType, parseWebhookBody, webhookEventOf } from './mapping'

export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature'
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id'

/** `unsupported_event` carries the event type/id so it can be recorded, not retried. */
export type RazorpayWebhookVerification = WebhookVerification

/**
 * Verifies the delivery against every configured webhook secret (test and live
 * secrets may both be present during a controlled cutover) and returns the
 * internal event. An authentic delivery for an event type we ignore is reported
 * as `unsupported_event` so the caller records it without treating it as an
 * attack or retrying forever.
 */
export function verifyRazorpayWebhook(input: {
  rawBody: string
  headers: Record<string, string>
  secrets: Array<string | undefined>
}): RazorpayWebhookVerification {
  const signature = input.headers[RAZORPAY_SIGNATURE_HEADER]
  const secrets = input.secrets.filter((secret): secret is string => Boolean(secret))
  if (secrets.length === 0) return { ok: false, reason: 'secret_unavailable' }

  let lastReason: 'missing' | 'malformed' | 'digest_mismatch' | 'stale_timestamp' = 'missing'
  let verified = false
  for (const secret of secrets) {
    const result = verifyBodySignature({ signature, secret, body: input.rawBody })
    if (result.ok) {
      verified = true
      break
    }
    if (result.reason !== 'secret_unavailable') lastReason = result.reason
  }
  if (!verified) return { ok: false, reason: lastReason }

  const payload = parseWebhookBody(input.rawBody)
  if (!payload) return { ok: false, reason: 'unparsable' }

  const eventId = input.headers[RAZORPAY_EVENT_ID_HEADER] ?? payload.eventId ?? null
  if (!eventId) {
    // Without an event id we cannot guarantee one economic effect per event, so
    // the delivery is refused rather than processed twice.
    return { ok: false, reason: 'unparsable' }
  }

  if (!mapEventType(payload.eventType)) {
    return { ok: false, reason: 'unsupported_event', eventType: payload.eventType, eventId }
  }

  const event = webhookEventOf({ payload, eventId })
  if (!event) return { ok: false, reason: 'unparsable' }
  return { ok: true, event }
}
