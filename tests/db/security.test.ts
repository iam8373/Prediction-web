import 'server-only'

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

/**
 * Source-level security audit for the payment surface.
 *
 * This is deliberately a STATIC audit: it proves properties of the shipped
 * source (who authenticates, where the wallet is written, what reaches the
 * client bundle) rather than runtime behaviour. Runtime behaviour is covered by
 * the PostgreSQL E2E suites. Anything that can only be proven by a browser is
 * reported as BLOCKED in the verification report rather than claimed here.
 */

const root = path.resolve(import.meta.dirname, '..', '..')

function filesUnder(relative: string): string[] {
  const absolute = path.join(root, relative)
  try {
    return readdirSync(absolute, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath ?? absolute, entry.name))
      .map((file) => path.relative(root, file))
      .sort()
  } catch {
    return []
  }
}

const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

const ADMIN_API_ROUTES = filesUnder('app/api/admin').filter((file) => file.endsWith('route.ts'))

/**
 * Pre-existing non-payment writers of the wallet table. Trading settlement and
 * referral payouts own their own money paths and were explicitly out of scope
 * for Phase 9, so they are listed here rather than silently tolerated.
 * Payment routes must never appear in this map.
 */
const PRE_EXISTING_WALLET_WRITERS: Record<string, string> = {
  'app/api/admin/markets/resolve/route.ts': 'trading market settlement (pre-existing feature)',
}
const WALLET_API_ROUTES = filesUnder('app/api/wallet').filter((file) => file.endsWith('route.ts'))
const CLIENT_COMPONENTS = [...filesUnder('components'), ...filesUnder('app')]
  .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
  .filter((file) => read(file).includes("'use client'") || read(file).includes('"use client"'))

describe('Admin financial authorization is server-side', () => {
  test('there is an admin API surface to audit', () => {
    assert.ok(ADMIN_API_ROUTES.length >= 10, `expected the admin API routes, found ${ADMIN_API_ROUTES.length}`)
  })

  test('the admin gate itself resolves the session server-side and requires an admin role', () => {
    // Every admin route delegates to this one server-side gate (asserted below),
    // so the gate is where the authorization decision must be provably correct.
    const source = read('lib/security/admin-guard.ts')
    assert.match(source, /^import 'server-only'/m, 'the admin gate must be server-only')
    assert.match(source, /getCurrentUser\(\)/, 'the gate must resolve the session from the server')
    assert.match(source, /if \(!user\.isAdmin\)/, 'the gate must check the server-side admin role')
    assert.match(source, /status: 401/, 'the gate must refuse an unauthenticated caller')
    assert.match(source, /status: 403/, 'the gate must refuse a signed-in non-admin')
    assert.match(source, /SECURITY_EVENTS\.authzDenied/, 'refusals must be recorded')
    assert.match(source, /SECURITY_EVENTS\.unauthenticated/)
  })

  test('every admin route authorizes through the shared server-side gate', () => {
    for (const file of ADMIN_API_ROUTES) {
      const source = read(file)
      assert.match(source, /requireAdmin\(request/, `${file} must authorize through requireAdmin`)
      assert.match(source, /if \(!guard\.ok\) return guard\.response/, `${file} must return the refusal response`)
      // A route must never hand-roll its own privileged response: that is how an
      // endpoint drifts away from the audited decision path.
      assert.doesNotMatch(source, /isAdmin/, `${file} must not re-implement the admin check`)
      assert.doesNotMatch(source, /getCurrentUser\(\)/, `${file} must not resolve the session itself`)
    }
  })

  test('no admin route trusts client-supplied identity', () => {
    for (const file of ADMIN_API_ROUTES) {
      const source = read(file)
      // Identity must come from the session cookie, never from a header, query
      // string or body field the caller controls.
      assert.doesNotMatch(source, /headers\.get\(['"]x-(user|admin|role)/i, `${file} must not trust an identity header`)
      assert.doesNotMatch(source, /searchParams\.get\(['"]?(isAdmin|admin|role)['"]?\)/i, `${file} must not trust a role query param`)
      assert.doesNotMatch(source, /\{\s*isAdmin\s*\}\s*=\s*(await request\.json\(\)|input)/, `${file} must not trust a client isAdmin flag`)
      assert.doesNotMatch(source, /from ['"]@\/lib\/store/, `${file} must not use the client store as an authorization source`)
      // When an admin acts on a *subject* (a user id) the ACTOR is still the
      // session: any financial mutation must be attributed to the session admin.
      // A read-only view (e.g. the wallet audit) has no actor to attribute.
      const mutatesMoney = /refundTransaction|resolveWithdrawal|retryPayment|runPaymentReconciliation|purgeExpiredPaymentRecords/.test(source)
      if (mutatesMoney) {
        assert.match(
          source,
          /(?:adminUserId|actorUserId):\s*admin\.id/,
          `${file} must attribute the action to the session admin`,
        )
      }
    }
  })

  test('no payment admin route mutates the wallet directly', () => {
    for (const file of ADMIN_API_ROUTES) {
      const source = read(file)
      const writes = /update\(wallets\)|insert\(wallets\)/.test(source)
      if (PRE_EXISTING_WALLET_WRITERS[file]) {
        assert.equal(writes, true, `${file} is listed as a pre-existing wallet writer but no longer writes — update the audit`)
        assert.equal(file.includes('/payments/'), false, 'a payment route must never be excused from this rule')
        continue
      }
      assert.equal(writes, false, `${file} must go through the payment service for money movement`)
    }
  })
})

describe('User payment endpoints', () => {
  test('every wallet route authenticates before doing anything', () => {
    for (const file of WALLET_API_ROUTES) {
      const source = read(file)
      assert.match(source, /getCurrentUser\(\)/, `${file} must authenticate the caller`)
      assert.match(source, /status: 401|UNAUTHORIZED/, `${file} must refuse an unauthenticated caller`)
    }
  })

  test('no wallet route mutates the wallet or the ledger directly', () => {
    for (const file of WALLET_API_ROUTES) {
      const source = read(file)
      assert.doesNotMatch(source, /update\(wallets\)|insert\(wallets\)|insert\(ledgerEntries\)|insert\(transactions\)/, `${file} must delegate to the payment service`)
    }
  })

  test('a redirect or client call cannot confirm a payment', () => {
    // The only wallet-crediting entry points are the service and the
    // signature-verified webhook; there is no "confirm payment" endpoint.
    const walletSources = WALLET_API_ROUTES.map(read).join('\n')
    assert.doesNotMatch(walletSources, /markVerifiedAndSettleDeposit|settleDeposit|settleWithdrawal/)
    assert.doesNotMatch(walletSources, /status\s*[:=]\s*['"]completed['"]/)
    const depositRoute = read('app/api/wallet/deposit/route.ts')
    assert.match(depositRoute, /createDepositPayment/, 'the deposit route only creates a payment')
  })

  test('the webhook route reads the raw body and delegates to the signed handler', () => {
    const source = read('app/api/payments/webhook/route.ts')
    assert.match(source, /request\.text\(\)/, 'the raw body is required for signature verification')
    assert.match(source, /handleProviderWebhook/)
    assert.match(source, /MAX_WEBHOOK_BYTES/, 'oversized payloads are rejected before cryptographic work')
    assert.doesNotMatch(source, /request\.json\(\)/, 'the body must not be parsed before verification')
  })
})

const API_ROUTES = filesUnder('app/api').filter((file) => file.endsWith('route.ts'))
const MUTATING_ROUTES = API_ROUTES.filter((file) => /export async function (POST|PATCH|PUT|DELETE)/.test(read(file)))

/**
 * Routes whose abuse protection is deliberately NOT the shared guard.
 *
 * `webhook` authenticates by signature (a browser Origin check would break
 * provider callbacks) and rate-limits per client address itself; `sign-out`
 * carries no payload and only clears the caller's own session, so it needs the
 * cross-site check but no budget.
 */
const ABUSE_GUARD_EXEMPT: Record<string, string> = {
  'app/api/payments/webhook/route.ts': 'signature-authenticated provider callback; uses its own per-address budget',
  'app/api/auth/sign-out/route.ts': 'clears only the caller’s own session; no payload and no economic effect',
}

describe('Abuse protection covers every state-changing endpoint', () => {
  test('there is a mutating surface to audit', () => {
    assert.ok(MUTATING_ROUTES.length >= 15, `expected the mutating API routes, found ${MUTATING_ROUTES.length}`)
  })

  test('every mutating route is cross-site protected and rate limited', () => {
    for (const file of MUTATING_ROUTES) {
      const source = read(file)
      const guarded = /guardRequest\(|requireAdmin\(request/.test(source)
      const originChecked = guarded || /assertTrustedRequestOrigin\(/.test(source)
      const rateLimited = guarded || /enforceRateLimit\(/.test(source)

      if (ABUSE_GUARD_EXEMPT[file]) {
        assert.match(source, /enforceRateLimit\(|assertTrustedRequestOrigin\(/, `${file} is exempt from the shared guard but must still protect itself`)
        continue
      }
      assert.ok(originChecked, `${file} must reject cross-site state changes`)
      assert.ok(rateLimited, `${file} must be rate limited server-side`)
    }
  })

  test('the webhook endpoint keeps its own signature-based protection', () => {
    const source = read('app/api/payments/webhook/route.ts')
    assert.match(source, /enforceRateLimit\(\{ bucket: 'webhook'/, 'provider deliveries are budgeted per address')
    assert.match(source, /content-length/, 'an oversized declared body is refused before it is buffered')
    assert.match(source, /request\.text\(\)/, 'the raw body is still what reaches the verifier')
    assert.doesNotMatch(source, /assertTrustedRequestOrigin/, 'a provider callback is cross-site by nature')
  })

  test('a request body is size-capped before any route reads it', () => {
    for (const file of MUTATING_ROUTES) {
      if (file === 'app/api/auth/sign-out/route.ts') continue
      const source = read(file)
      // `readJsonBody` streams the body and aborts past the ceiling, `guardRequest`
      // and `requireAdmin` call the declared-length check, and the webhook route
      // re-checks the buffered bytes itself.
      assert.match(
        source,
        /assertRequestSize\(|assertJsonRequestBody\(|readJsonBody\(|guardRequest\(|requireAdmin\(request|MAX_WEBHOOK_BYTES/,
        `${file} must bound the body it is willing to read`,
      )
    }
  })

  test('no endpoint trusts a money state or a role from the request body', () => {
    const forbidden = /(?:body|input|payload)\s*(?:\?\.)?\.(availablePaise|lockedPaise|bonusPaise|balancePaise|balance|isAdmin|providerStatus|refundStatus|reconciliationStatus)\b/
    for (const file of API_ROUTES) {
      assert.doesNotMatch(read(file), forbidden, `${file} must never take money state or privilege from the client`)
    }
  })
})

describe('Ledger and transaction history are append-only', () => {
  test('the database enforces immutability, not just convention', () => {
    const schema = read('lib/db/security-schema.ts')
    assert.match(schema, /create trigger ledger_entry_immutable/, 'ledger_entry needs a guard trigger')
    assert.match(schema, /create trigger transaction_immutable/, 'transaction needs a guard trigger')
    assert.match(schema, /append-only/, 'the trigger must explain itself')
    assert.match(schema, /new\.amount_paise is distinct from old\.amount_paise/, 'the money columns must be immutable')
  })

  test('the immutability objects are part of the bootstrap', () => {
    const bootstrap = read('lib/db/bootstrap.ts')
    assert.match(bootstrap, /securitySchemaStatements\(\)/, 'a fresh database must get the triggers too')
  })

  test('application code never deletes an accounting row', () => {
    const sources = [...filesUnder('lib'), ...filesUnder('app'), ...filesUnder('scripts')]
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
      .filter((file) => !file.includes('security-schema'))
      .filter((file) => !file.includes('bootstrap'))
    for (const file of sources) {
      assert.doesNotMatch(read(file), /delete\(ledgerEntries\)|delete\(transactions\)/, `${file} must never delete accounting history`)
    }
  })

  test('only the status column of an accounting row is ever updated', () => {
    const files = [...filesUnder('lib'), ...filesUnder('app')].filter((file) => file.endsWith('.ts'))
    for (const file of files) {
      const source = read(file)
      for (const match of source.matchAll(/\.update\((ledgerEntries|transactions)\)\s*\.set\(\{([^}]*)\}/g)) {
        const columns = match[2]
        assert.match(columns, /status/, `${file} updates an accounting row without a status change: ${columns}`)
        assert.doesNotMatch(
          columns,
          /amountPaise|reference|userId|createdAt|type:/,
          `${file} must not rewrite accounting history (only status may change)`,
        )
      }
    }
  })
})

describe('Secret handling', () => {
  test('credential modules are server-only', () => {
    for (const file of ['lib/payments/provider-credentials.ts', 'lib/payments/razorpay/provider.ts', 'lib/db/index.ts']) {
      assert.match(read(file), /^import 'server-only'/m, `${file} must never reach a client bundle`)
    }
  })

  test('no client component imports a server-only payment module', () => {
    for (const file of CLIENT_COMPONENTS) {
      const source = read(file)
      for (const forbidden of [
        '@/lib/payments/service',
        '@/lib/payments/provider-credentials',
        '@/lib/payments/razorpay/',
        '@/lib/payments/webhook',
        '@/lib/db',
      ]) {
        assert.equal(source.includes(forbidden), false, `${file} imports server-only module ${forbidden}`)
      }
    }
  })

  test('secret environment variables are only read server-side', () => {
    const secretNames = [
      'PAYMENTS_RAZORPAY_TEST_KEY_SECRET',
      'PAYMENTS_RAZORPAY_LIVE_KEY_SECRET',
      'PAYMENTS_RAZORPAY_TEST_WEBHOOK_SECRET',
      'PAYMENTS_RAZORPAY_LIVE_WEBHOOK_SECRET',
      'PAYMENTS_WEBHOOK_SECRET_SANDBOX',
    ]
    for (const file of CLIENT_COMPONENTS) {
      const source = read(file)
      for (const secret of secretNames) {
        assert.equal(source.includes(secret), false, `${file} references secret ${secret}`)
      }
    }
  })

  test('no credential or secret is hardcoded in the payment source', () => {
    const paymentFiles = filesUnder('lib/payments').filter((file) => file.endsWith('.ts'))
    assert.ok(paymentFiles.length > 10)
    for (const file of paymentFiles) {
      const source = read(file)
      assert.doesNotMatch(source, /rzp_(live|test)_[A-Za-z0-9]{6,}/, `${file} contains something that looks like a live/test key`)
      assert.doesNotMatch(source, /whsec_[A-Za-z0-9]{10,}/, `${file} contains something that looks like a webhook secret`)
    }
    // Secrets must be read from the environment, never defaulted.
    const credentials = read('lib/payments/provider-credentials.ts')
    assert.match(credentials, /process\.env\[/)
    assert.doesNotMatch(credentials, /keySecret\s*[:=]\s*['"][^'"]+['"]\s*[,}]/, 'a key secret must never have a literal default')
  })

  test('the client-facing payment projection contains no secrets', () => {
    const config = read('lib/payments/config.ts')
    const projection = config.slice(config.indexOf('export function publicPaymentConfig'))
    for (const forbidden of ['keySecret', 'webhookSecret', 'apiKey', 'accountNumber']) {
      assert.equal(projection.includes(forbidden), false, `publicPaymentConfig must not expose ${forbidden}`)
    }
  })
})

describe('Money integrity', () => {
  test('payment amounts are integers everywhere in the payment layer', () => {
    const paymentFiles = filesUnder('lib/payments').filter((file) => file.endsWith('.ts'))
    for (const file of paymentFiles) {
      const source = read(file)
      assert.doesNotMatch(source, /amountPaise\s*[*\/]\s*[\d.]+(?![0-9])/, `${file} multiplies/divides an amount by a literal`)
      assert.doesNotMatch(source, /toFixed\(/, `${file} formats money with floats`)
      assert.doesNotMatch(source, /parseFloat\(/, `${file} parses money with parseFloat`)
    }
  })

  test('the amount normalizer rejects values that are not whole paise', () => {
    const limits = read('lib/payments/limits.ts')
    assert.match(limits, /Number\.isInteger|Math\.round/)
    assert.match(limits, /normalizeProviderAmountToPaise/)
  })

  test('the wallet schema stores integers', () => {
    const schema = read('lib/db/schema.ts')
    const wallet = schema.slice(schema.indexOf("pgTable('wallet'"), schema.indexOf("pgTable('ledger_entry'"))
    assert.doesNotMatch(wallet, /numeric|decimal|real|doublePrecision/i)
    assert.match(wallet, /bigint\('available_paise'/)
    assert.match(wallet, /bigint\('locked_paise'/)
  })

  test('the deposit webhook path credits through a single service writer', () => {
    const webhook = read('lib/payments/webhook.ts')
    assert.match(webhook, /applyProviderEvent/)
    assert.doesNotMatch(webhook, /update\(wallets\)/, 'the webhook layer must never touch a balance itself')
  })
})

describe('Logging hygiene', () => {
  test('no payment source logs a payload, a secret or a credential', () => {
    const paymentFiles = [...filesUnder('lib/payments'), ...filesUnder('app/api/payments')].filter((file) => file.endsWith('.ts'))
    for (const file of paymentFiles) {
      const source = read(file)
      const logLines = source
        .split('\n')
        .filter((line) => /console\.(log|error|warn|info|debug)/.test(line))
      for (const line of logLines) {
        assert.doesNotMatch(line, /rawBody|keySecret|webhookSecret|credential|authorization|payload\b/i, `${file} logs sensitive material: ${line.trim()}`)
      }
    }
  })
})
