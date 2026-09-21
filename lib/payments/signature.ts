/**
 * Webhook signature helpers.
 *
 * The signed header format is:
 *   `X-Predik-Signature: t=<unix seconds>,v1=<hex hmac-sha256>`
 * where the signed payload is `${t}.${rawBody}` and the key is the provider's
 * webhook signing secret. The timestamp bounds replay; the digest comparison is
 * constant-time. A missing secret means "cannot verify", which is a rejection —
 * never an implicit success.
 *
 * Pure module (node:crypto only) so it can be unit tested directly.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-predik-signature'
export const DEFAULT_TOLERANCE_SECONDS = 300

export function signWebhookBody(secret: string, body: string, timestampSeconds: number): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
}

export function buildSignatureHeader(secret: string, body: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${signWebhookBody(secret, body, timestampSeconds)}`
}

export type SignatureFailure =
  | 'missing'
  | 'malformed'
  | 'stale_timestamp'
  | 'digest_mismatch'
  | 'secret_unavailable'

export type SignatureVerification =
  | { ok: true; timestamp: number }
  | { ok: false; reason: SignatureFailure }

function parseHeader(header: string) {
  const parts = header.split(',')
  let timestamp: number | undefined
  let digest: string | undefined
  for (const part of parts) {
    const [key, value] = part.trim().split('=')
    if (key === 't' && value) timestamp = Number(value)
    if (key === 'v1' && value) digest = value
  }
  if (!timestamp || !Number.isFinite(timestamp) || !digest) return null
  return { timestamp, digest }
}

/**
 * Providers that sign the raw body only (no timestamp in the signature, e.g.
 * Razorpay's `X-Razorpay-Signature`) are verified here. Replay protection for
 * those providers comes from the provider event id, which is stored with a
 * unique constraint, rather than from the signature itself.
 */
export function verifyBodySignature(input: {
  signature: string | undefined | null
  secret: string | undefined | null
  body: string
}): SignatureVerification {
  const { signature, secret, body } = input
  if (!secret) return { ok: false, reason: 'secret_unavailable' }
  if (!signature) return { ok: false, reason: 'missing' }
  const digest = signature.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(digest)) return { ok: false, reason: 'malformed' }
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'), 'hex')
  const actual = Buffer.from(digest, 'hex')
  if (expected.length === 0 || expected.length !== actual.length) return { ok: false, reason: 'digest_mismatch' }
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: 'digest_mismatch' }
  return { ok: true, timestamp: 0 }
}

export function verifyWebhookSignature(input: {
  header: string | undefined | null
  secret: string | undefined | null
  body: string
  nowSeconds?: number
  toleranceSeconds?: number
}): SignatureVerification {
  const { header, secret, body } = input
  if (!secret) return { ok: false, reason: 'secret_unavailable' }
  if (!header) return { ok: false, reason: 'missing' }

  const parsed = parseHeader(header)
  if (!parsed) return { ok: false, reason: 'malformed' }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: 'stale_timestamp' }

  const expected = Buffer.from(signWebhookBody(secret, body, parsed.timestamp), 'hex')
  const actual = Buffer.from(parsed.digest, 'hex')
  if (expected.length === 0 || expected.length !== actual.length) return { ok: false, reason: 'digest_mismatch' }
  if (!timingSafeEqual(expected, actual)) return { ok: false, reason: 'digest_mismatch' }
  return { ok: true, timestamp: parsed.timestamp }
}

/** Stable, non-reversible fingerprint used to audit rejected payloads. */
export function payloadFingerprint(body: string): string {
  return createHmac('sha256', 'predik-payload-fingerprint').update(body).digest('hex')
}
