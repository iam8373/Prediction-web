import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { getSessionCookieOptions } from '@/lib/auth/session'
import { decideRequestOrigin, isTrustedRequestOrigin, selfHosts, trustedHosts } from '@/lib/security/request-origin'

/**
 * Session cookie attributes and the cross-site allowlist.
 *
 * Both used to widen themselves when a hosting platform's sandbox variables were
 * present in the environment. That made the deployment's own security posture a
 * function of environment variables nothing in this repository set, so the
 * behaviour is now driven by the deployment mode and by explicit configuration
 * only. These tests pin that down.
 */

/** `process.env.NODE_ENV` is typed read-only, but the deployment mode is what these tests vary. */
function setNodeEnv(value: string) {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

const originalNodeEnv = process.env.NODE_ENV

const sandboxVariables = [
  'V0_RUNTIME_URL',
  'V0_DEV_APP_URL',
  'V0_BUILD_URL',
  'V0_SANDBOX_URL',
]

afterEach(() => {
  setNodeEnv(originalNodeEnv ?? 'test')
  delete process.env.TRUSTED_ORIGINS
  delete process.env.VERCEL_URL
  delete process.env.VERCEL_BRANCH_URL
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL
  for (const name of sandboxVariables) delete process.env[name]
})

describe('session cookie attributes', () => {
  test('production sends an HTTPS-only, cross-site cookie', () => {
    setNodeEnv('production')
    assert.deepEqual(getSessionCookieOptions(), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    })
  })

  test('development keeps a plain-HTTP-safe cookie', () => {
    setNodeEnv('development')
    const options = getSessionCookieOptions()
    assert.equal(options.secure, false)
    assert.equal(options.sameSite, 'lax')
    assert.equal(options.httpOnly, true, 'the session token must never be readable from JavaScript')
  })

  test('sandbox environment variables no longer weaken the production cookie', () => {
    setNodeEnv('production')
    for (const name of sandboxVariables) process.env[name] = 'https://sandbox.example.com'
    assert.deepEqual(getSessionCookieOptions(), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    })
  })

  test('sandbox environment variables no longer switch development onto SameSite=None', () => {
    // `SameSite=None` without `Secure` is rejected by browsers, so a cookie set
    // that way is silently dropped and sign-in appears to do nothing.
    setNodeEnv('development')
    for (const name of sandboxVariables) process.env[name] = 'https://sandbox.example.com'
    assert.equal(getSessionCookieOptions().sameSite, 'lax')
    assert.equal(getSessionCookieOptions().secure, false)
  })
})

describe('trusted origins', () => {
  const request = (headers: Record<string, string>) =>
    new Request('https://app.predik.test/api/wallet/withdraw', { method: 'POST', headers })

  test('a sandbox variable is not an origin allowlist', () => {
    process.env.V0_RUNTIME_URL = 'https://evil.example.com'
    assert.equal(isTrustedRequestOrigin(request({
      host: 'app.predik.test',
      origin: 'https://evil.example.com',
    })).ok, false)
  })

  test('a state change from this host is allowed and from another host is refused', () => {
    assert.equal(isTrustedRequestOrigin(request({ host: 'app.predik.test', origin: 'https://app.predik.test' })).ok, true)
    assert.equal(isTrustedRequestOrigin(request({ host: 'app.predik.test', origin: 'https://evil.example.com' })).ok, false)
  })

  test('TRUSTED_ORIGINS is the way to allow the proxy host a deployment is reached on', () => {
    process.env.TRUSTED_ORIGINS = 'https://predik.example.com'
    const forwarded = request({
      host: 'internal:3000',
      'x-forwarded-host': 'predik.example.com',
      origin: 'https://predik.example.com',
    })
    assert.equal(selfHosts(forwarded).has('predik.example.com'), true)
    assert.equal(isTrustedRequestOrigin(forwarded).ok, true)
  })

  test('a host the operator did not publish is never trusted, even as X-Forwarded-Host', () => {
    const spoofed = request({
      host: 'internal:3000',
      'x-forwarded-host': 'evil.example.com',
      origin: 'https://evil.example.com',
    })
    assert.equal(isTrustedRequestOrigin(spoofed).ok, false)
    assert.equal(
      decideRequestOrigin({
        method: 'POST',
        origin: 'https://evil.example.com',
        hosts: selfHosts(spoofed),
        trusted: trustedHosts(),
      }).ok,
      false,
    )
  })
})
