import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { isConfiguredAdminPhone, resolveOtpCode } from '@/lib/auth/admin'
import { clientIp } from '@/lib/security/client-ip'
import { anonymisedClientRef } from '@/lib/security/events'
import {
  MAX_JSON_BODY_BYTES,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  assertJsonRequestBody,
  assertRequestSize,
  securityErrorResponse,
} from '@/lib/security/guard'
import { decideRequestOrigin, isTrustedRequestOrigin, selfHosts, trustedHosts } from '@/lib/security/request-origin'
import { rateLimitKeyHash, RATE_LIMITS } from '@/lib/security/rate-limit'
import { isAllowedCheckoutUrl, isPublicHostname, redirectPathFor, safeCheckoutUrl, safeInternalPath } from '@/lib/security/url-safety'
import {
  adminWithdrawalActionSchema,
  depositSchema,
  reconciliationRunSchema,
  sellSchema,
  tradeSchema,
  withdrawSchema,
} from '@/lib/validation/schemas'

/**
 * Security unit suite: pure decision functions that need no database.
 *
 * Everything here is a decision function or a schema: no database and no
 * network, so these run everywhere. Database-backed proofs of the same
 * properties (row locks, idempotency, immutability, real sessions) live in
 * `tests/db/*`.
 */

/**
 * `process.env.NODE_ENV` is typed read-only by @types/node, but the deployment
 * mode is exactly what these tests must vary.
 */
function setNodeEnv(value: string) {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

const trusted = new Set(['app.predik.test', 'preview.predik.test'])
const decision = (input: { method?: string; origin?: string | null; host?: string | null; hosts?: string[] }) =>
  decideRequestOrigin({
    method: input.method ?? 'POST',
    origin: input.origin ?? null,
    hosts: new Set(input.hosts ?? [input.host ?? 'app.predik.test']),
    trusted,
  })

afterEach(() => {
  delete process.env.TRUSTED_ORIGINS
  delete process.env.ADMIN_PHONES
  delete process.env.OTP_FIXED_CODE
  delete process.env.ALLOW_DEMO_OTP
})

describe('cross-site request protection (CSRF)', () => {
  test('a same-origin state change is allowed', () => {
    assert.deepEqual(decision({ origin: 'https://app.predik.test' }), { ok: true, origin: 'https://app.predik.test' })
  })

  test('a cross-origin state change is refused', () => {
    const result = decision({ origin: 'https://evil.example.com' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'cross_origin')
  })

  test('a lookalike subdomain of the request host is not trusted', () => {
    assert.equal(decision({ origin: 'https://evil-app.predik.test' }).ok, false)
  })

  test('an explicitly configured trusted origin is allowed', () => {
    assert.equal(decision({ origin: 'https://preview.predik.test' }).ok, true)
    process.env.TRUSTED_ORIGINS = 'https://ops.predik.test, http://localhost:3000'
    const trustedNow = trustedHosts()
    assert.ok(trustedNow.has('ops.predik.test'), 'a configured origin must be trusted')
    assert.ok(trustedNow.has('localhost:3000'), 'a configured dev origin must be trusted')
    assert.equal(
      decideRequestOrigin({ method: 'POST', origin: 'https://ops.predik.test', hosts: new Set(['app.predik.test']), trusted: trustedNow }).ok,
      true,
    )
    assert.equal(
      decideRequestOrigin({ method: 'POST', origin: 'https://evil.example.com', hosts: new Set(['app.predik.test']), trusted: trustedNow }).ok,
      false,
    )
  })

  test('a spoofed X-Forwarded-Host cannot make an attacker origin look same-site', () => {
    // The attack this guards: send `Origin: https://evil.example.com` together
    // with `X-Forwarded-Host: evil.example.com` hoping the server compares the
    // origin against the header it was handed.
    const request = new Request('https://app.predik.test/api/wallet/withdraw', {
      method: 'POST',
      headers: {
        host: 'app.predik.test',
        'x-forwarded-host': 'evil.example.com',
        origin: 'https://evil.example.com',
      },
    })
    const hosts = selfHosts(request)
    assert.equal(hosts.has('evil.example.com'), false, 'an unconfigured forwarded host is not identity')
    assert.equal(hosts.has('app.predik.test'), true)
    assert.equal(isTrustedRequestOrigin(request).ok, false)
  })

  test('a forwarded host the operator published IS honoured (proxy deployment)', () => {
    process.env.TRUSTED_ORIGINS = 'https://proxy.predik.test'
    const request = new Request('http://internal:3000/api/wallet/withdraw', {
      method: 'POST',
      headers: {
        host: 'internal:3000',
        'x-forwarded-host': 'proxy.predik.test',
        origin: 'https://proxy.predik.test',
      },
    })
    assert.equal(selfHosts(request).has('proxy.predik.test'), true)
    assert.equal(isTrustedRequestOrigin(request).ok, true)
  })

  test('a request with no Origin at all is still allowed (not a browser cross-site call)', () => {
    const request = new Request('https://app.predik.test/api/wallet/withdraw', {
      method: 'POST',
      headers: { host: 'app.predik.test' },
    })
    assert.equal(isTrustedRequestOrigin(request).ok, true)
  })

  test('an unparsable / opaque origin (including "null") is refused', () => {
    assert.equal(decision({ origin: 'null' }).ok, false)
    assert.equal(decision({ origin: 'javascript:alert(1)' }).ok, false)
  })

  test('requests with no origin information are allowed (they are not forgeable by a web page)', () => {
    assert.equal(decision({ origin: null }).ok, true)
  })

  test('safe (idempotent) methods are never blocked', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(decision({ method, origin: 'https://evil.example.com' }).ok, true)
    }
  })

  test('a Referer is used when no Origin header is present', () => {
    assert.equal(decision({ origin: 'https://evil.example.com/steal' }).ok, false)
  })

  test('a case-different origin host still matches the request host', () => {
    assert.equal(decision({ origin: 'https://APP.PREDIK.TEST' }).ok, true)
  })
})

describe('checkout URL safety (open-redirect and provider-page trust)', () => {
  test('only https pages on the provider hosts are allowed', () => {
    assert.equal(isAllowedCheckoutUrl('https://razorpay.com/pay/abc'), true)
    assert.equal(isAllowedCheckoutUrl('https://api.razorpay.com/checkout'), true)
    assert.equal(isAllowedCheckoutUrl('https://rzp.io/l/abc123'), true)
  })

  test('other schemes, hosts and credential tricks are refused', () => {
    for (const value of [
      'http://razorpay.com/pay/abc',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://razorpay.com.evil.example.com/pay',
      'https://evil.example.com/pay',
      'https://user:pass@razorpay.com/pay',
      'https://localhost/pay',
      '//razorpay.com/pay',
      '',
      null,
      undefined,
      42,
      `https://razorpay.com/${'a'.repeat(3000)}`,
    ]) {
      assert.equal(isAllowedCheckoutUrl(value), false, `should reject ${String(value).slice(0, 40)}`)
    }
  })

  test('safeCheckoutUrl degrades to undefined instead of passing junk through', () => {
    assert.equal(safeCheckoutUrl('https://razorpay.com/pay/abc'), 'https://razorpay.com/pay/abc')
    assert.equal(safeCheckoutUrl('https://evil.example.com/pay'), undefined)
  })

  test('an operator can extend the checkout allowlist but not replace it', () => {
    process.env.PAYMENTS_CHECKOUT_HOSTS = 'payments.predik.test'
    assert.equal(isAllowedCheckoutUrl('https://payments.predik.test/x'), true)
    assert.equal(isAllowedCheckoutUrl('https://razorpay.com/pay/x'), true)
    assert.equal(isAllowedCheckoutUrl('https://evil.example.com/x'), false)
    delete process.env.PAYMENTS_CHECKOUT_HOSTS
  })

  test('internal redirect targets must be same-site absolute paths', () => {
    assert.equal(safeInternalPath('/wallet?tab=activity'), '/wallet?tab=activity')
    for (const value of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com', '/a\r\nb', 'javascript:alert(1)', 'wallet', '']) {
      assert.equal(safeInternalPath(value), null, `should reject ${JSON.stringify(value)}`)
    }
    assert.equal(redirectPathFor('https://evil.example.com', '/wallet'), '/wallet')
  })
})

describe('SSRF host classification', () => {
  test('internal, loopback, link-local and reserved addresses are refused', () => {
    for (const host of [
      'localhost',
      'foo.localhost',
      'service.internal',
      'printer.local',
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '224.0.0.1',
      '::1',
      '[::1]',
    ]) {
      assert.equal(isPublicHostname(host), false, `${host} must not be reachable`)
    }
  })

  test('public addresses and hostnames are allowed', () => {
    for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', 'api.razorpay.com']) {
      assert.equal(isPublicHostname(host), true, `${host} should be allowed`)
    }
  })
})

describe('request body shape', () => {
  const post = (headers: Record<string, string>, body?: string) =>
    new Request('https://app.predik.test/api/wallet/deposit', { method: 'POST', headers, body })

  test('a JSON body is accepted, including charset and +json variants', () => {
    for (const contentType of ['application/json', 'application/json; charset=utf-8', 'application/vnd.predik+json']) {
      assert.doesNotThrow(() => assertJsonRequestBody(post({ 'content-type': contentType }, '{"a":1}')))
    }
  })

  test('the simple-request CSRF content types are refused with 415', () => {
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      'application/xml',
    ]) {
      assert.throws(() => assertJsonRequestBody(post({ 'content-type': contentType }, 'a=1')), UnsupportedMediaTypeError)
    }
  })

  test('a body with no content type at all is refused', () => {
    assert.throws(() => assertJsonRequestBody(post({ 'content-length': '12' })), UnsupportedMediaTypeError)
  })

  test('a bodyless request (sign-out) is unaffected', () => {
    assert.doesNotThrow(() => assertJsonRequestBody(new Request('https://app.predik.test/api/auth/sign-out', { method: 'POST' })))
  })

  test('safe methods are never shape-checked', () => {
    assert.doesNotThrow(() => assertJsonRequestBody(new Request('https://app.predik.test/api/markets', { headers: { 'content-type': 'text/plain' } })))
  })

  test('malformed JSON is a 400, not a 500', () => {
    const response = securityErrorResponse(new SyntaxError('Unexpected token o in JSON at position 1'))
    assert.ok(response)
    assert.equal(response.status, 400)
  })

  test('the rejection is mapped to HTTP 415', async () => {
    const response = securityErrorResponse(new UnsupportedMediaTypeError('text/plain'))
    assert.ok(response)
    assert.equal(response.status, 415)
    assert.deepEqual(response.body, { ok: false, error: 'This endpoint expects a JSON request body.' })
  })
})

describe('request body ceiling', () => {
  test('an oversized declared body is refused before it is read', () => {
    const request = new Request('https://app.predik.test/api/wallet/deposit', {
      method: 'POST',
      headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
    })
    assert.throws(() => assertRequestSize(request), PayloadTooLargeError)
  })

  test('a normal body passes and a missing length is not treated as oversized', () => {
    assert.doesNotThrow(() => assertRequestSize(new Request('https://app.predik.test/api/wallet/deposit', { method: 'POST' })))
    assert.doesNotThrow(() =>
      assertRequestSize(
        new Request('https://app.predik.test/api/wallet/deposit', { method: 'POST', headers: { 'content-length': '128' } }),
      ),
    )
  })

  test('the rejection is mapped to HTTP 413 with a non-revealing message', async () => {
    const response = securityErrorResponse(new PayloadTooLargeError(MAX_JSON_BODY_BYTES))
    assert.ok(response)
    assert.equal(response.status, 413)
    assert.deepEqual(response.body, { ok: false, error: 'That request was too large.' })
  })
})

describe('admin privilege comes from configuration, never from source', () => {
  const original = process.env.NODE_ENV

  afterEach(() => {
    setNodeEnv(original ?? 'test')
  })

  test('production with no allowlist grants nobody admin', () => {
    setNodeEnv('production')
    assert.equal(isConfiguredAdminPhone('9876543210'), false)
  })

  test('production honours exactly the configured allowlist', () => {
    setNodeEnv('production')
    process.env.ADMIN_PHONES = '9876543210, +91 91234 56780'
    assert.equal(isConfiguredAdminPhone('9876543210'), true)
    assert.equal(isConfiguredAdminPhone('9123456780'), true, 'the +91 form and the bare number are the same operator')
    assert.equal(isConfiguredAdminPhone('+91 99887 76655'), false)
    assert.equal(isConfiguredAdminPhone('9999999999'), false)
    assert.equal(isConfiguredAdminPhone(''), false)
    assert.equal(isConfiguredAdminPhone(null), false)
  })

  test('development keeps the documented demo number working', () => {
    setNodeEnv('development')
    assert.equal(isConfiguredAdminPhone('9876543210'), true)
    assert.equal(isConfiguredAdminPhone('9000000001'), false)
  })
})

describe('sign-in code configuration fails closed in production', () => {
  const original = process.env.NODE_ENV

  afterEach(() => {
    setNodeEnv(original ?? 'test')
  })

  test('production with no configured code issues nothing', () => {
    setNodeEnv('production')
    assert.deepEqual(resolveOtpCode(), { mode: 'unavailable' })
  })

  test('a configured production code is used but never disclosed to the client', () => {
    setNodeEnv('production')
    process.env.OTP_FIXED_CODE = '135790'
    assert.deepEqual(resolveOtpCode(), { mode: 'configured', code: '135790', disclose: false })
  })

  test('a malformed configured code is refused rather than trusted', () => {
    setNodeEnv('production')
    process.env.OTP_FIXED_CODE = 'abc'
    assert.deepEqual(resolveOtpCode(), { mode: 'unavailable' })
  })

  test('explicitly opting into the demo code is possible but never disclosed in production', () => {
    setNodeEnv('production')
    process.env.ALLOW_DEMO_OTP = 'true'
    assert.deepEqual(resolveOtpCode(), { mode: 'demo', code: '424242', disclose: false })
  })

  test('development uses the demo code and discloses it on screen', () => {
    setNodeEnv('development')
    assert.deepEqual(resolveOtpCode(), { mode: 'demo', code: '424242', disclose: true })
  })
})

describe('rate limiting is server-side, shared and identifier-free', () => {
  test('the money-handling buckets are rate limited', () => {
    for (const bucket of ['deposit', 'withdrawal', 'trade', 'otpVerifyPhone', 'adminAction', 'webhook'] as const) {
      assert.ok(RATE_LIMITS[bucket].limit > 0)
      assert.ok(RATE_LIMITS[bucket].windowMs > 0)
    }
    assert.ok(RATE_LIMITS.withdrawal.limit < RATE_LIMITS.trade.limit, 'withdrawals must be tighter than trading')
  })

  test('keys are stored as one-way digests and are stable per identity', () => {
    const first = rateLimitKeyHash('user:abc')
    assert.equal(first, rateLimitKeyHash('user:abc'))
    assert.notEqual(first, rateLimitKeyHash('user:abd'))
    assert.match(first, /^[a-f0-9]{64}$/)
    assert.ok(!first.includes('abc'))
  })
})

describe('the client address comes from the proxy, not from the caller', () => {
  const request = (headers: Record<string, string>) => new Request('https://app.predik.test/api/auth/otp', { headers })

  test('the hop the proxy appended is used', () => {
    assert.equal(clientIp(request({ 'x-forwarded-for': '203.0.113.77' })), '203.0.113.77')
  })

  test('a caller-supplied entry in front of it is ignored', () => {
    // The attack: prepend a fresh address per request so every request gets its
    // own rate-limit bucket. The proxy appends the real address after whatever
    // the caller sent, so only the last entry describes the connection.
    assert.equal(
      clientIp(request({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' })),
      '198.51.100.9',
    )
    assert.notEqual(clientIp(request({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' })), '1.2.3.4')
  })

  test('a chain of forged entries cannot hide the real one', () => {
    assert.equal(
      clientIp(request({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.9' })),
      '198.51.100.9',
    )
  })

  test('with no forwarding chain there is no identity to trust', () => {
    // A header reaching the process directly was written by the caller, so it is
    // never treated as an address.
    assert.equal(clientIp(request({})), 'unknown')
    assert.equal(clientIp(request({ 'x-real-ip': '1.2.3.4' })), 'unknown')
    assert.equal(clientIp(request({ 'cf-connecting-ip': '1.2.3.4' })), 'unknown')
  })

  test('an over-long address is truncated rather than stored whole', () => {
    assert.ok(clientIp(request({ 'x-forwarded-for': `${'9'.repeat(200)}, 198.51.100.9` })).length <= 64)
  })
})

describe('security events keep identifying data out of the audit trail', () => {
  const request = (headers: Record<string, string>) => new Request('https://app.predik.test/api/auth/otp', { headers })

  test('an IPv4 client is truncated to a /16 prefix', () => {
    assert.equal(anonymisedClientRef(request({ 'x-forwarded-for': '203.0.113.77' })), '203.0.0.0/16')
  })

  test('an IPv6 client is truncated to its routing prefix', () => {
    assert.equal(anonymisedClientRef(request({ 'x-forwarded-for': '2001:db8:1::5' })), '2001:db8::/32')
  })

  test('a forged prefix cannot choose what the audit trail records', () => {
    assert.equal(
      anonymisedClientRef(request({ 'x-forwarded-for': '10.0.0.1, 203.0.113.77' })),
      '203.0.0.0/16',
    )
  })

  test('a missing or malformed address is never echoed verbatim', () => {
    assert.equal(anonymisedClientRef(request({})), 'unknown')
    assert.equal(anonymisedClientRef(request({ 'x-forwarded-for': 'not-an-ip' })), 'unknown')
  })
})

describe('runtime validation rejects what TypeScript cannot', () => {
  test('deposit amounts must be whole, positive, in-range paise', () => {
    assert.equal(depositSchema.safeParse({ amountPaise: 50_000 }).success, true)
    for (const amountPaise of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      99,
      10_000.5,
      999_999_999,
      '50000',
      null,
    ]) {
      assert.equal(depositSchema.safeParse({ amountPaise }).success, false, `should reject ${String(amountPaise)}`)
    }
  })

  test('deposit methods are an enum, not free text', () => {
    assert.equal(depositSchema.safeParse({ amountPaise: 50_000, method: 'upi' }).success, true)
    assert.equal(depositSchema.safeParse({ amountPaise: 50_000, method: 'card' }).success, false)
    assert.equal(depositSchema.safeParse({ amountPaise: 50_000, method: 'upi;drop table wallets' }).success, false)
  })

  test('withdrawal amounts are bounded', () => {
    assert.equal(withdrawSchema.safeParse({ amountPaise: 50_000, destination: 'trader@upi' }).success, true)
    assert.equal(withdrawSchema.safeParse({ amountPaise: Number.NaN, destination: 'trader@upi' }).success, false)
    assert.equal(withdrawSchema.safeParse({ amountPaise: 1.5, destination: 'trader@upi' }).success, false)
    assert.equal(withdrawSchema.safeParse({ amountPaise: 50_000 }).success, false)
  })

  test('a withdrawal destination must be a UPI ID, not free text', () => {
    for (const destination of ['trader@upi', 'trader.name@okaxis', '9876543210@ybl', 'a-b_c@paytm']) {
      assert.equal(
        withdrawSchema.safeParse({ amountPaise: 50_000, destination }).success,
        true,
        `${destination} is a valid UPI ID`,
      )
    }
    for (const destination of [
      'ab',
      'trader',
      '@upi',
      'trader@',
      'trader@@upi',
      'trader@u',
      'trader@upi bank',
      'trader @upi',
      'trader@up/i',
      'https://evil.example.com',
      'trader@upi;drop table wallet',
      `${'x'.repeat(65)}@upi`,
      `trader@${'x'.repeat(65)}`,
    ]) {
      assert.equal(
        withdrawSchema.safeParse({ amountPaise: 50_000, destination }).success,
        false,
        `${JSON.stringify(destination)} should be refused before a payout is queued`,
      )
    }

    // Surrounding whitespace is normalised rather than rejected: the value that
    // reaches the payout is the trimmed address, never the pasted one.
    assert.equal(
      withdrawSchema.parse({ amountPaise: 50_000, destination: '  trader@upi\n' }).destination,
      'trader@upi',
    )
  })

  test('trade and sell reject absurd quantities, prices and identifiers', () => {
    assert.equal(tradeSchema.safeParse({ marketId: 'm1', outcomeId: 'm1:yes', side: 'buy', amountPaise: 10_000 }).success, true)
    assert.equal(tradeSchema.safeParse({ marketId: 'm1', outcomeId: 'm1:yes', side: 'buy', amountPaise: Number.NaN }).success, false)
    assert.equal(tradeSchema.safeParse({ marketId: 'm1', outcomeId: 'm1:yes', side: 'buy', amountPaise: 10_000_000 }).success, false)
    assert.equal(tradeSchema.safeParse({ marketId: 'x'.repeat(5000), outcomeId: 'm1:yes', side: 'buy', amountPaise: 10_000 }).success, false)

    assert.equal(sellSchema.safeParse({ marketId: 'm1', outcomeId: 'm1:yes', milliShares: 1_000 }).success, true)
    assert.equal(sellSchema.safeParse({ marketId: 'm1', outcomeId: 'm1:yes', milliShares: 0 }).success, false)
    assert.equal(sellSchema.safeParse({ marketId: 'm1', outcomeId: 'm1:yes', milliShares: -5 }).success, false)
    assert.equal(sellSchema.safeParse({ marketId: 'm1', outcomeId: 'm1:yes', milliShares: 1.5 }).success, false)
    assert.equal(sellSchema.safeParse({ marketId: 'm1', outcomeId: 'm1:yes', milliShares: Number.MAX_SAFE_INTEGER }).success, false)
  })

  test('admin actions take bounded identifiers and enums', () => {
    assert.equal(adminWithdrawalActionSchema.safeParse({ paymentId: 'pay_1', action: 'complete' }).success, true)
    assert.equal(adminWithdrawalActionSchema.safeParse({ paymentId: 'x'.repeat(500), action: 'complete' }).success, false)
    assert.equal(adminWithdrawalActionSchema.safeParse({ paymentId: 'pay_1', action: 'refund' }).success, false)
  })

  test('reconciliation bounds are enforced rather than clamped silently', () => {
    assert.equal(reconciliationRunSchema.safeParse({ limit: 50, sinceDays: 7 }).success, true)
    assert.equal(reconciliationRunSchema.safeParse({ limit: 5000 }).success, false)
    assert.equal(reconciliationRunSchema.safeParse({ sinceDays: 0 }).success, false)
    assert.equal(reconciliationRunSchema.safeParse({ limit: 1.5 }).success, false)
  })
})
