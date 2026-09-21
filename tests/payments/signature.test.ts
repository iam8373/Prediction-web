import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSignatureHeader,
  DEFAULT_TOLERANCE_SECONDS,
  payloadFingerprint,
  verifyWebhookSignature,
} from '../../lib/payments/signature.ts'

const SECRET = 'whsec_test_secret_value'
const BODY = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' })
const NOW = 1_800_000_000

function verify(overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) {
  return verifyWebhookSignature({
    header: buildSignatureHeader(SECRET, BODY, NOW),
    secret: SECRET,
    body: BODY,
    nowSeconds: NOW,
    ...overrides,
  })
}

describe('webhook signatures', () => {
  it('accepts a correctly signed delivery', () => {
    const result = verify()
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.timestamp, NOW)
  })

  it('rejects a delivery signed with a different secret', () => {
    const result = verify({ header: buildSignatureHeader('another_secret', BODY, NOW) })
    assert.deepEqual(result, { ok: false, reason: 'digest_mismatch' })
  })

  it('rejects a tampered body', () => {
    const result = verify({ body: `${BODY} ` })
    assert.deepEqual(result, { ok: false, reason: 'digest_mismatch' })
  })

  it('rejects a missing signature header', () => {
    assert.deepEqual(verify({ header: undefined }), { ok: false, reason: 'missing' })
  })

  it('rejects a malformed signature header', () => {
    assert.deepEqual(verify({ header: 'v1=deadbeef' }), { ok: false, reason: 'malformed' })
    assert.deepEqual(verify({ header: 't=notanumber,v1=deadbeef' }), { ok: false, reason: 'malformed' })
    assert.deepEqual(verify({ header: 't=,,v1=' }), { ok: false, reason: 'malformed' })
  })

  it('rejects a digest of the wrong length without throwing', () => {
    assert.deepEqual(verify({ header: `t=${NOW},v1=abcd` }), { ok: false, reason: 'digest_mismatch' })
  })

  it('rejects a replayed delivery outside the tolerance window', () => {
    const stale = verify({ nowSeconds: NOW + DEFAULT_TOLERANCE_SECONDS + 1 })
    assert.deepEqual(stale, { ok: false, reason: 'stale_timestamp' })
    const future = verify({ nowSeconds: NOW - DEFAULT_TOLERANCE_SECONDS - 1 })
    assert.deepEqual(future, { ok: false, reason: 'stale_timestamp' })
  })

  it('accepts a clock skew inside the tolerance window', () => {
    assert.equal(verify({ nowSeconds: NOW + DEFAULT_TOLERANCE_SECONDS - 1 }).ok, true)
  })

  it('fails closed when no secret is configured', () => {
    assert.deepEqual(verify({ secret: undefined }), { ok: false, reason: 'secret_unavailable' })
    assert.deepEqual(verify({ secret: '' }), { ok: false, reason: 'secret_unavailable' })
  })

  it('is stable per body but different across bodies', () => {
    assert.equal(payloadFingerprint(BODY), payloadFingerprint(BODY))
    assert.notEqual(payloadFingerprint(BODY), payloadFingerprint(`${BODY}\n`))
  })

  it('never embeds the secret in the signature header', () => {
    assert.ok(!buildSignatureHeader(SECRET, BODY, NOW).includes(SECRET))
  })
})
