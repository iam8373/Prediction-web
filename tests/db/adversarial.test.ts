import 'server-only'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { POST as paymentsWebhookRoute } from '@/app/api/payments/webhook/route'
import { POST as resolveMarket } from '@/app/api/admin/markets/resolve/route'
import { POST as adminRefund } from '@/app/api/admin/wallet/refund/route'
import { GET as adminPayments } from '@/app/api/admin/payments/route'
import { POST as sellRoute } from '@/app/api/trading/sell/route'
import { POST as buyRoute } from '@/app/api/trading/buy/route'
import { POST as depositRoute } from '@/app/api/wallet/deposit/route'
import { GET as paymentsListRoute } from '@/app/api/wallet/payments/route'
import { POST as withdrawRoute } from '@/app/api/wallet/withdraw/route'
import { PATCH as notificationsPatch } from '@/app/api/notifications/route'
import { POST as watchlistPost } from '@/app/api/watchlist/route'
import { createSession } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { ledgerEntries, marketOutcomes, markets, notifications, paymentIntents, positions, transactions } from '@/lib/db/schema'
import { createDepositPayment } from '@/lib/payments/service'
import { quoteBuy, quoteSell } from '@/lib/trading/pricing'
import { __resetRequestCookies, __setRequestCookies } from '../stubs/next-headers.mjs'
import {
  closePool,
  createTestUser,
  databaseUrl,
  notificationsForUser,
  rawSql,
  readWallet,
  resetDatabase,
} from './harness.ts'
import { SANDBOX_SECRET, configureSandboxEnv, deliverWebhook, providerOutcomeWebhook, sandboxEvent } from './sandbox.ts'

/**
 * Adversarial suite: hostile requests against the real route handlers.
 *
 * Every test here is an attack attempt against the real route handlers and a
 * real PostgreSQL database: identity tampering, money tampering, state
 * tampering, provider/event tampering, protocol-level malformation, stale and
 * replayed requests, modified headers and altered cookies. A test passes only
 * when the request is rejected AND the database is provably unchanged — the
 * point is not that an error is returned, but that no money or state moved.
 */

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'

before(async () => {
  if (skip) return
  await resetDatabase()
  configureSandboxEnv()
})

after(async () => {
  __resetRequestCookies()
  await closePool()
})

afterEach(() => {
  __resetRequestCookies()
})

const API = 'https://app.predik.test'

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  return new Request(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'host': 'app.predik.test', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Safe rendering for hostile values in assertion messages (`String()` can throw on these). */
function label(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? typeof value
  } catch {
    return typeof value
  }
}

/** A raw request with an arbitrary (possibly malformed) body. */
function rawRequest(path: string, rawBody: string | undefined, headers: Record<string, string> = {}, method = 'POST') {
  return new Request(`${API}${path}`, { method, headers: { host: 'app.predik.test', ...headers }, body: rawBody })
}

async function signIn(userId: string) {
  const token = await createSession(userId)
  __setRequestCookies({ predik_session: token })
  return token
}

/**
 * Everything that must be identical before and after a refused attack:
 * balances plus the number of economic records. Notifications are deliberately
 * excluded — a legitimate review flag may notify a user, and that is not money.
 */
async function accountState(userId: string) {
  const wallet = await readWallet(userId)
  const one = async (sqlText: string) => {
    const rows = await rawSql<{ count: string }>(sqlText, [userId])
    return Number(rows[0]?.count ?? '0')
  }
  return {
    availablePaise: Number(wallet.availablePaise),
    lockedPaise: Number(wallet.lockedPaise),
    bonusPaise: Number(wallet.bonusPaise),
    payments: await one('select count(*)::text as count from payment_intent where user_id = $1'),
    transactions: await one('select count(*)::text as count from "transaction" where user_id = $1'),
    ledger: await one('select count(*)::text as count from ledger_entry where user_id = $1'),
  }
}

let marketCounter = 0

async function createMarket(input: { userId?: string; milliShares?: number; yesPricePaise?: number }) {
  marketCounter += 1
  const id = `market_adv_${process.pid}_${marketCounter}_${randomUUID().slice(0, 6)}`
  const now = Date.now()
  const yesPrice = input.yesPricePaise ?? 500
  await db.insert(markets).values({
    id,
    slug: `${id}-slug`,
    question: `Adversarial market ${marketCounter}?`,
    headline: 'Yes vs No',
    description: 'Created by the adversarial suite.',
    resolutionCriteria: 'Resolved by the adversarial suite.',
    source: 'adversarial test suite',
    categoryId: 'cat_test',
    kind: 'binary',
    status: 'open',
    emblem: 'ADV',
    createdAt: now,
    opensAt: now - 1000,
    closesAt: now + 86_400_000,
    resolvesAt: now + 172_800_000,
    volumePaise: 0,
    liquidityPaise: 500_000,
    traders: 0,
  })
  await db.insert(marketOutcomes).values([
    { id: `${id}:yes`, marketId: id, name: 'Yes', side: 'yes', pricePaise: yesPrice, previousPricePaise: yesPrice },
    { id: `${id}:no`, marketId: id, name: 'No', side: 'no', pricePaise: 1000 - yesPrice, previousPricePaise: 1000 - yesPrice },
  ])
  if (input.userId && (input.milliShares ?? 0) > 0) {
    await db.insert(positions).values({
      id: `pos_adv_${marketCounter}_${randomUUID().slice(0, 6)}`,
      userId: input.userId,
      marketId: id,
      outcomeId: `${id}:yes`,
      milliShares: input.milliShares ?? 0,
      averagePricePaise: yesPrice,
      realisedPnlPaise: 0,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    })
  }
  // The liquidity the server prices this market against, so a test can derive
  // the expected fill with the same quote function instead of hard-coding it.
  return { marketId: id, yesOutcomeId: `${id}:yes`, noOutcomeId: `${id}:no`, yesPricePaise: yesPrice, liquidityPaise: 500_000 }
}

/* ------------------------------------------------------------------ *
 * 1. Identity and IDOR
 * ------------------------------------------------------------------ */

describe('Attack: identity and object-reference tampering (IDOR)', () => {
  test('a withdrawal cannot be pointed at another account', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 100_000 })
    const victim = await createTestUser({ availablePaise: 100_000 })
    const before = await accountState(victim.userId)
    await signIn(attacker.userId)

    const response = await withdrawRoute(
      jsonRequest('/api/wallet/withdraw', {
        amountPaise: 50_000,
        destination: 'attacker@upi',
        userId: victim.userId,
        accountId: victim.userId,
        phone: victim.phone,
      }),
    )

    assert.equal(response.status, 200, 'the request is served — for the session user')
    const after = await accountState(victim.userId)
    assert.deepEqual(after, before, "the victim's account must be untouched")

    const attackerPaid = await rawSql<{ user_id: string }>('select user_id from payment_intent where destination = $1', ['attacker@upi'])
    assert.equal(attackerPaid.length, 1)
    assert.equal(attackerPaid[0].user_id, attacker.userId)
  })

  test('a deposit cannot be created in another account name', { skip }, async () => {
    const attacker = await createTestUser({})
    const victim = await createTestUser({})
    const before = await accountState(victim.userId)
    await signIn(attacker.userId)

    const response = await depositRoute(
      jsonRequest('/api/wallet/deposit', { amountPaise: 50_000, method: 'upi', userId: victim.userId, ownerId: victim.userId }),
    )
    assert.equal(response.status, 200)

    const rows = await rawSql<{ user_id: string }>('select user_id from payment_intent order by created_at desc limit 1')
    assert.equal(rows[0].user_id, attacker.userId, 'the payment belongs to the session user')
    assert.deepEqual(await accountState(victim.userId), before)
  })

  test('payment history cannot be redirected to another user by query parameter', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 100_000 })
    const victim = await createTestUser({ availablePaise: 100_000 })
    await createDepositPayment({ userId: victim.userId, amountPaise: 50_000, method: 'upi', requestKey: 'victim-deposit' })
    await signIn(attacker.userId)

    const response = await paymentsListRoute(
      new Request(`${API}/api/wallet/payments?userId=${victim.userId}&user=${victim.userId}&limit=200`, {
        headers: { host: 'app.predik.test' },
      }),
    )
    const payload = (await response.json()) as { payments: Array<{ userId?: string }> }
    assert.equal(response.status, 200)
    assert.equal(payload.payments.length, 0, "another user's payments must never be returned")
  })

  test('another user\'s notification cannot be marked read through its id', { skip }, async () => {
    const attacker = await createTestUser({})
    const victim = await createTestUser({ availablePaise: 100_000 })
    await db.insert(notifications).values({
      id: `notification_victim_${randomUUID().slice(0, 8)}`,
      userId: victim.userId,
      eventKey: `adv:${randomUUID()}`,
      kind: 'account',
      title: "Victim's notification",
      description: 'Adversarial fixture',
      createdAt: Date.now(),
    })
    const [victimNotification] = await notificationsForUser(victim.userId)
    await signIn(attacker.userId)

    const response = await notificationsPatch(jsonRequest('/api/notifications', { id: victimNotification.id }, {}, 'PATCH'))
    assert.equal(response.status, 200, 'the endpoint answers normally')
    const [stillUnread] = await db.select().from(notifications).where(eq(notifications.id, victimNotification.id))
    assert.equal(stillUnread.readAt, null, "another user's notification must stay untouched")
  })

  test('a watchlist entry cannot be written for another user', { skip }, async () => {
    const attacker = await createTestUser({})
    const victim = await createTestUser({})
    const { marketId } = await createMarket({})
    await signIn(attacker.userId)

    const response = await watchlistPost(jsonRequest('/api/watchlist', { marketId, watched: true, userId: victim.userId }))
    assert.equal(response.status, 200)
    const rows = await rawSql<{ user_id: string }>('select user_id from watchlist where market_id = $1', [marketId])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].user_id, attacker.userId)
  })

  test('an outcome id belonging to a different market is refused', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 100_000 })
    const marketA = await createMarket({})
    const marketB = await createMarket({})
    const before = await accountState(trader.userId)
    await signIn(trader.userId)

    const response = await buyRoute(
      jsonRequest(
        '/api/trading/buy',
        { marketId: marketA.marketId, outcomeId: marketB.yesOutcomeId, amountPaise: 10_000 },
        { 'idempotency-key': 'cross-market-outcome' },
      ),
    )
    assert.equal(response.status, 404, 'a foreign outcome id must not resolve inside this market')
    assert.deepEqual(await accountState(trader.userId), before)
  })

  test("a non-admin cannot reach admin data by naming another user's id", { skip }, async () => {
    const attacker = await createTestUser({})
    const victim = await createTestUser({ availablePaise: 100_000 })
    await signIn(attacker.userId)

    const adminGets: Array<[string, (request: Request) => Promise<Response>]> = [
      ['/api/admin/payments?userId=…', adminPayments],
      ['/api/admin/payments/wallet-audit?userId=…', (await import('@/app/api/admin/payments/wallet-audit/route')).GET],
      ['/api/admin/transactions?query=…', (await import('@/app/api/admin/transactions/route')).GET],
    ]
    for (const [name, handler] of adminGets) {
      const response = await handler(new Request(`${API}${name.split('?')[0]}?userId=${victim.userId}&query=${victim.userId}`, { headers: { host: 'app.predik.test' } }))
      assert.equal(response.status, 403, `${name} must refuse a normal user`)
    }
  })

  test('a user cannot see another user\'s payments even with a valid session of their own', { skip }, async () => {
    const first = await createTestUser({ availablePaise: 100_000 })
    const second = await createTestUser({ availablePaise: 100_000 })
    await createDepositPayment({ userId: first.userId, amountPaise: 50_000, method: 'upi', requestKey: 'first-deposit' })
    await createDepositPayment({ userId: second.userId, amountPaise: 70_000, method: 'upi', requestKey: 'second-deposit' })

    await signIn(second.userId)
    const response = await paymentsListRoute(new Request(`${API}/api/wallet/payments`, { headers: { host: 'app.predik.test' } }))
    const payload = (await response.json()) as { payments: Array<{ amountPaise: number }> }
    assert.equal(payload.payments.length, 1)
    assert.equal(payload.payments[0].amountPaise, 70_000)
  })
})

/* ------------------------------------------------------------------ *
 * 2. Money tampering
 * ------------------------------------------------------------------ */

describe('Attack: money tampering', () => {
  const hostileAmounts: unknown[] = [
    0,
    -1,
    -50_000,
    10.5,
    0.001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e15,
    9_007_199_254_740_991,
    '50000',
    '5e4',
    true,
    null,
    undefined,
    {},
    [],
    [50_000],
    { toString: 50_000 },
  ]

  test('hostile deposit amounts are all refused and create nothing', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)
    const before = await accountState(attacker.userId)

    for (const amountPaise of hostileAmounts) {
      const response = await depositRoute(jsonRequest('/api/wallet/deposit', { amountPaise, method: 'upi' }))
      assert.ok(
        response.status >= 400 && response.status < 500,
        `amount ${label(amountPaise)} must be a client error, got ${response.status}`,
      )
    }
    assert.deepEqual(await accountState(attacker.userId), before, 'no payment may exist after refused amounts')
  })

  test('hostile withdrawal amounts are all refused and reserve nothing', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 100_000 })
    await signIn(attacker.userId)
    const before = await accountState(attacker.userId)

    for (const amountPaise of hostileAmounts) {
      const response = await withdrawRoute(jsonRequest('/api/wallet/withdraw', { amountPaise, destination: 'attacker@upi' }))
      assert.ok(
        response.status >= 400 && response.status < 500,
        `amount ${label(amountPaise)} must be a client error, got ${response.status}`,
      )
    }
    assert.deepEqual(await accountState(attacker.userId), before)
  })

  test('a withdrawal above the available balance is refused without reserving funds', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 10_000 })
    await signIn(attacker.userId)

    const response = await withdrawRoute(jsonRequest('/api/wallet/withdraw', { amountPaise: 10_001, destination: 'a@upi' }))
    assert.ok(response.status >= 400)
    const wallet = await readWallet(attacker.userId)
    assert.equal(Number(wallet.availablePaise), 10_000)
    assert.equal(Number(wallet.lockedPaise), 0)
  })

  test('client-supplied price, quote, fee and balance fields are ignored on a trade', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 100_000 })
    const market = await createMarket({})
    await signIn(trader.userId)

    const response = await buyRoute(
      jsonRequest(
        '/api/trading/buy',
        {
          marketId: market.marketId,
          outcomeId: market.yesOutcomeId,
          amountPaise: 10_000,
          // None of these exist in the contract: the server must price the trade.
          pricePaise: 1,
          quote: { milliShares: 999_999_000, feePaise: 0 },
          milliShares: 999_999_000,
          feePaise: 0,
          payoutPaise: 1_000_000,
          availablePaise: 1_000_000_000,
          balancePaise: 1_000_000_000,
        },
        { 'idempotency-key': 'mass-assignment-buy' },
      ),
    )
    assert.equal(response.status, 200)
    const payload = (await response.json()) as { quote: { milliShares: number; feePaise: number }; wallet: { availablePaise: number } }

    // The executed size follows the server's quote for this order — the market
    // mid plus the order's own slippage — and not the client's fantasy.
    const expected = quoteBuy(10_000, market.yesPricePaise, market.liquidityPaise)
    assert.equal(payload.quote.milliShares, expected.milliShares, 'the quote must be server-computed')
    assert.notEqual(payload.quote.milliShares, 999_999_000, 'the client-supplied size must be ignored')
    assert.equal(payload.wallet.availablePaise, 90_000, 'the balance deducted is the real one')

    const [stored] = await db.select().from(positions).where(eq(positions.userId, trader.userId))
    assert.equal(Number(stored.milliShares), expected.milliShares)
    assert.equal(Number(stored.averagePricePaise), expected.pricePaise, 'the cost basis is the price actually paid')
  })

  test('a client cannot state its own payout on a sell', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 0 })
    const market = await createMarket({ userId: 'unused', milliShares: 0 })
    await signIn(trader.userId)
    // Give the trader a position at a *different* cost basis than the client claims.
    await db.insert(positions).values({
      id: `pos_adv_${randomUUID().slice(0, 8)}`,
      userId: trader.userId,
      marketId: market.marketId,
      outcomeId: market.yesOutcomeId,
      milliShares: 10_000,
      averagePricePaise: 500,
      realisedPnlPaise: 0,
      status: 'open',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    const response = await sellRoute(
      jsonRequest(
        '/api/trading/sell',
        {
          marketId: market.marketId,
          outcomeId: market.yesOutcomeId,
          milliShares: 5_000,
          pricePaise: 9_999,
          netValuePaise: 999_999_999,
          amountPaise: 999_999_999,
        },
        { 'idempotency-key': 'mass-assignment-sell' },
      ),
    )
    assert.equal(response.status, 200)
    const payload = (await response.json()) as { quote: { grossValuePaise: number }; wallet: { availablePaise: number } }
    // 5 shares at the market mid of 500, less this order's slippage — computed by
    // the server, never taken from the request.
    const expected = quoteSell(5_000, market.yesPricePaise, 500, market.liquidityPaise)
    assert.equal(payload.quote.grossValuePaise, expected.grossValuePaise, 'the payout must be server-computed')
    assert.notEqual(payload.quote.grossValuePaise, 999_999_999, 'the client-supplied value must be ignored')
    assert.equal(payload.wallet.availablePaise, expected.netValuePaise)
  })

  test('a deposit cannot be marked settled by the client', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)

    const response = await depositRoute(
      jsonRequest('/api/wallet/deposit', {
        amountPaise: 50_000,
        method: 'upi',
        status: 'completed',
        settled: true,
        settledImmediately: true,
        providerStatus: 'captured',
      }),
    )
    const payload = (await response.json()) as { status: string; settled: boolean }
    assert.equal(response.status, 200)
    assert.equal(payload.status, 'pending', 'sandbox deposits settle only on a verified webhook')
    assert.equal(payload.settled, false)

    const wallet = await readWallet(attacker.userId)
    assert.equal(Number(wallet.availablePaise), 0, 'no credit without a provider event')
  })

  test('a redirect or callback URL in the request body cannot influence the checkout target', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)

    const response = await depositRoute(
      jsonRequest('/api/wallet/deposit', {
        amountPaise: 50_000,
        method: 'upi',
        redirectUrl: 'https://evil.example.com/steal',
        callbackUrl: 'https://evil.example.com/callback',
        returnUrl: 'javascript:alert(1)',
        checkoutUrl: 'https://evil.example.com/pay',
      }),
    )
    const payload = (await response.json()) as { checkoutUrl?: string }
    assert.equal(response.status, 200)
    if (payload.checkoutUrl !== undefined) {
      assert.match(payload.checkoutUrl, /^https:\/\//, 'only an https provider page may be returned')
      assert.equal(payload.checkoutUrl.includes('evil.example.com'), false)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 3. Protocol-level manipulation
 * ------------------------------------------------------------------ */

describe('Attack: protocol-level manipulation', () => {
  test('missing fields are refused', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)

    for (const body of [{}, { method: 'upi' }, { method: 'upi', amountPaise: null }, { amountPaise: null, method: null }]) {
      const response = await depositRoute(jsonRequest('/api/wallet/deposit', body))
      assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be refused`)
    }
    const before = await accountState(attacker.userId)
    assert.equal(before.payments, 0, 'no payment may be created by a malformed request')
  })

  test('a missing optional field falls back to a server-side default, not to client input', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)

    const response = await depositRoute(jsonRequest('/api/wallet/deposit', { amountPaise: 50_000 }))
    assert.equal(response.status, 200)
    const rows = await rawSql<{ method: string }>('select method from payment_intent where user_id = $1', [attacker.userId])
    assert.equal(rows.length, 1)
    assert.ok(['demo', 'upi', 'netbanking'].includes(rows[0].method), 'the method comes from the schema default')
  })

  test('duplicate JSON keys resolve to one value and are still validated', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)

    // A duplicate key cannot smuggle an out-of-range value past validation.
    const smuggling = await depositRoute(
      rawRequest('/api/wallet/deposit', '{"amountPaise":50000,"method":"upi","amountPaise":1e15}', {
        'content-type': 'application/json',
      }),
    )
    assert.equal(smuggling.status, 400)

    // The last value wins, and it is a valid, bounded amount.
    const legitimate = await depositRoute(
      rawRequest('/api/wallet/deposit', '{"amountPaise":1,"method":"upi","amountPaise":50000}', {
        'content-type': 'application/json',
      }),
    )
    assert.equal(legitimate.status, 200)
    const rows = await rawSql<{ amount_paise: string }>('select amount_paise from payment_intent where user_id = $1', [attacker.userId])
    assert.equal(rows.length, 1)
    assert.equal(Number(rows[0].amount_paise), 50_000)
  })

  test('malformed JSON is a client error, not a server error', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)

    for (const rawBody of ['{', 'not json', '{"amountPaise":}', '[]', '"string"', 'null']) {
      const response = await depositRoute(rawRequest('/api/wallet/deposit', rawBody, { 'content-type': 'application/json' }))
      assert.ok(response.status === 400 || response.status === 402, `body ${rawBody} must be refused with 400/402, got ${response.status}`)
      assert.ok(response.status < 500, 'a malformed body must never surface as a server error')
    }
  })

  test('a non-JSON content type is refused with 415 (the simple-request CSRF class)', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 100_000 })
    await signIn(attacker.userId)
    const before = await accountState(attacker.userId)

    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x', 'application/xml']) {
      const response = await withdrawRoute(
        rawRequest('/api/wallet/withdraw', 'amountPaise=50000&destination=a@upi', {
          'content-type': contentType,
          origin: 'https://evil.example.com',
        }),
      )
      assert.equal(response.status, 415, `${contentType} must be refused`)
    }
    assert.deepEqual(await accountState(attacker.userId), before)
  })

  test('an oversized body is refused before it is processed', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 100_000 })
    await signIn(attacker.userId)
    const before = await accountState(attacker.userId)

    const padded = JSON.stringify({ amountPaise: 50_000, destination: 'a@upi', padding: 'x'.repeat(200_000) })
    const response = await withdrawRoute(rawRequest('/api/wallet/withdraw', padded, { 'content-type': 'application/json' }))
    // Checked while STREAMING (no reliance on a client-supplied Content-Length),
    // so a chunked body cannot bypass the ceiling either.
    assert.equal(response.status, 413)
    assert.deepEqual(await accountState(attacker.userId), before)
  })

  test('oversized and malformed identifiers are refused', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 100_000 })
    const market = await createMarket({})
    await signIn(trader.userId)

    const hostile = [
      'x'.repeat(5_000),
      `${market.marketId}\u0000`,
      `${market.marketId}';drop table payment_intent;--`,
      '{"$ne":null}',
      '../../etc/passwd',
    ]
    for (const marketId of hostile) {
      const response = await buyRoute(
        jsonRequest('/api/trading/buy', { marketId, outcomeId: market.yesOutcomeId, amountPaise: 10_000 }, { 'idempotency-key': `hostile-${marketId.length}` }),
      )
      assert.ok(response.status >= 400, `marketId ${marketId.slice(0, 16)}… must be refused`)
    }
    // The schema survived the injection attempts.
    const tables = await rawSql<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = 'payment_intent'",
    )
    assert.equal(tables.length, 1, 'the payment table must still exist')
  })

  test('unexpected JSON types are refused', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 100_000 })
    const market = await createMarket({})
    await signIn(trader.userId)

    const bodies: unknown[] = [
      { marketId: 123, outcomeId: market.yesOutcomeId, amountPaise: 10_000 },
      { marketId: market.marketId, outcomeId: { id: market.yesOutcomeId }, amountPaise: 10_000 },
      { marketId: [market.marketId], outcomeId: market.yesOutcomeId, amountPaise: 10_000 },
      { marketId: market.marketId, outcomeId: market.yesOutcomeId, amountPaise: '10000' },
      { marketId: market.marketId, outcomeId: market.yesOutcomeId, amountPaise: { value: 10_000 } },
      { marketId: null, outcomeId: null, amountPaise: null },
    ]
    for (const body of bodies) {
      const response = await buyRoute(jsonRequest('/api/trading/buy', body, { 'idempotency-key': `types-${JSON.stringify(body).length}` }))
      assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be refused`)
    }
  })

  test('a modified Origin header is refused even with a valid session', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 100_000 })
    await signIn(attacker.userId)
    const before = await accountState(attacker.userId)

    const response = await withdrawRoute(
      jsonRequest('/api/wallet/withdraw', { amountPaise: 50_000, destination: 'a@upi' }, { origin: 'https://evil.example.com' }),
    )
    assert.equal(response.status, 403)
    assert.deepEqual(await accountState(attacker.userId), before)
  })

  test('a spoofed X-Forwarded-Host does not make a hostile origin same-site', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 100_000 })
    await signIn(attacker.userId)
    const before = await accountState(attacker.userId)

    const response = await withdrawRoute(
      jsonRequest(
        '/api/wallet/withdraw',
        { amountPaise: 50_000, destination: 'a@upi' },
        { origin: 'https://evil.example.com', 'x-forwarded-host': 'evil.example.com' },
      ),
    )
    assert.equal(response.status, 403, 'the forwarded host is not identity')
    assert.deepEqual(await accountState(attacker.userId), before)
  })

  test('identity headers are ignored', { skip }, async () => {
    const attacker = await createTestUser({ availablePaise: 100_000 })
    await signIn(attacker.userId)

    const response = await depositRoute(
      jsonRequest(
        '/api/wallet/deposit',
        { amountPaise: 50_000, method: 'upi' },
        {
          'x-user-id': 'user_somebody_else',
          'x-admin': 'true',
          'x-user-role': 'admin',
          'x-forwarded-user': 'user_somebody_else',
          authorization: 'Bearer made-up-token',
        },
      ),
    )
    assert.equal(response.status, 200)
    const rows = await rawSql<{ user_id: string }>('select user_id from payment_intent order by created_at desc limit 1')
    assert.equal(rows[0].user_id, attacker.userId)
  })
})

/* ------------------------------------------------------------------ *
 * 4. Cookies and sessions
 * ------------------------------------------------------------------ */

describe('Attack: cookie and session manipulation', () => {
  test('a random or tampered session token is refused', { skip }, async () => {
    const victim = await createTestUser({ availablePaise: 100_000 })
    const realToken = await createSession(victim.userId)

    const forgeries = [
      'not-a-token',
      `${realToken}x`,
      realToken.slice(0, -1),
      realToken.toUpperCase(),
      `' or 1=1 --`,
      '../../',
      Buffer.from(`${realToken}\u0000`).toString('base64'),
    ]
    for (const forged of forgeries) {
      __setRequestCookies({ predik_session: forged })
      const response = await paymentsListRoute(new Request(`${API}/api/wallet/payments`, { headers: { host: 'app.predik.test' } }))
      assert.equal(response.status, 401, `token ${forged.slice(0, 12)}… must be refused`)
    }
  })

  test('a revoked session stops working immediately', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 100_000 })
    const token = await signIn(trader.userId)
    assert.equal((await paymentsListRoute(new Request(`${API}/api/wallet/payments`, { headers: { host: 'app.predik.test' } }))).status, 200)

    await rawSql('delete from session where token = $1', [token])
    assert.equal((await paymentsListRoute(new Request(`${API}/api/wallet/payments`, { headers: { host: 'app.predik.test' } }))).status, 401)
  })

  test('a stolen non-admin session still cannot reach admin operations', { skip }, async () => {
    const victim = await createTestUser({ isAdmin: false, availablePaise: 100_000 })
    await signIn(victim.userId)

    const response = await adminRefund(jsonRequest('/api/admin/wallet/refund', { transactionId: 'txn_whatever' }))
    assert.equal(response.status, 403)
  })

  test('no session at all is refused everywhere that matters', { skip }, async () => {
    __setRequestCookies({})
    const requests: Array<[string, () => Promise<Response> | Response]> = [
      ['/api/wallet/payments', () => paymentsListRoute(new Request(`${API}/api/wallet/payments`, { headers: { host: 'app.predik.test' } }))],
      ['/api/wallet/deposit', () => depositRoute(jsonRequest('/api/wallet/deposit', { amountPaise: 50_000, method: 'upi' }))],
      ['/api/wallet/withdraw', () => withdrawRoute(jsonRequest('/api/wallet/withdraw', { amountPaise: 50_000, destination: 'a@upi' }))],
      ['/api/trading/buy', () => buyRoute(jsonRequest('/api/trading/buy', { marketId: 'm', outcomeId: 'm:yes', amountPaise: 10_000 }))],
      ['/api/notifications', () => notificationsPatch(jsonRequest('/api/notifications', { all: true }, {}, 'PATCH'))],
      ['/api/admin/payments', () => adminPayments(new Request(`${API}/api/admin/payments`, { headers: { host: 'app.predik.test' } }))],
      ['/api/admin/markets/resolve', () => resolveMarket(jsonRequest('/api/admin/markets/resolve', { marketId: 'm', outcomeId: 'm:yes' }))],
    ]
    for (const [name, call] of requests) {
      const response = await call()
      assert.equal(response.status, 401, `${name} must require authentication`)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 5. Replay, staleness and idempotency abuse
 * ------------------------------------------------------------------ */

describe('Attack: replay, staleness and idempotency abuse', () => {
  test('the same request key with a different amount is refused, not applied', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)

    const first = await depositRoute(jsonRequest('/api/wallet/deposit', { amountPaise: 50_000, method: 'upi' }, { 'idempotency-key': 'reuse-key' }))
    assert.equal(first.status, 200)

    const second = await depositRoute(jsonRequest('/api/wallet/deposit', { amountPaise: 200_000, method: 'upi' }, { 'idempotency-key': 'reuse-key' }))
    assert.equal(second.status, 409, 'reusing a key for a different amount must be refused')

    const rows = await rawSql<{ amount_paise: string }>('select amount_paise from payment_intent where user_id = $1', [attacker.userId])
    assert.equal(rows.length, 1, 'still exactly one payment')
    assert.equal(Number(rows[0].amount_paise), 50_000, 'and its amount is unchanged')
  })

  test('an exact replay returns the same payment instead of creating a second one', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)

    const body = { amountPaise: 60_000, method: 'upi' }
    const first = await depositRoute(jsonRequest('/api/wallet/deposit', body, { 'idempotency-key': 'exact-replay' }))
    const second = await depositRoute(jsonRequest('/api/wallet/deposit', body, { 'idempotency-key': 'exact-replay' }))
    const firstPayload = (await first.json()) as { paymentId: string }
    const secondPayload = (await second.json()) as { paymentId: string }

    assert.equal(firstPayload.paymentId, secondPayload.paymentId)
    assert.equal(await rawSql<{ count: string }>('select count(*)::text as count from payment_intent where user_id = $1', [attacker.userId]).then((r) => Number(r[0].count)), 1)
  })

  test('replayed and re-signed webhook deliveries cannot credit twice', { skip }, async () => {
    const trader = await createTestUser({})
    const deposit = await createDepositPayment({ userId: trader.userId, amountPaise: 50_000, method: 'upi', requestKey: 'webhook-replay' })
    const providerPaymentId = deposit.providerReference ?? (await rawSql<{ provider_payment_id: string }>('select provider_payment_id from payment_intent where id = $1', [deposit.paymentId]))[0].provider_payment_id

    const event = sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000, eventId: 'evt_replay_once' })
    const first = await deliverWebhook({ rawBody: event.rawBody, headers: event.headers })
    const walletAfterFirst = await readWallet(trader.userId)

    // Same event id, delivered again (identical bytes, then re-signed fresh).
    const repeatIdentical = await deliverWebhook({ rawBody: event.rawBody, headers: event.headers })
    const repeatFresh = await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000, eventId: 'evt_replay_once' }))
    const walletAfterRepeats = await readWallet(trader.userId)

    assert.equal(first.status, 200)
    assert.equal(repeatIdentical.body.duplicate ?? false, true, 'the identical delivery is recognised as a duplicate')
    assert.equal(walletAfterRepeats.availablePaise, walletAfterFirst.availablePaise, 'a replayed event must not credit again')
    assert.equal(Number(walletAfterRepeats.availablePaise), 50_000)

    // A brand new event id describing the *same* already-settled payment also
    // must not create a second credit.
    assert.ok([200, 202].includes(repeatFresh.status))
    const finalWallet = await readWallet(trader.userId)
    assert.equal(Number(finalWallet.availablePaise), 50_000, 'exactly one credit')
    assert.equal(
      await rawSql<{ count: string }>("select count(*)::text as count from ledger_entry where user_id = $1 and status = 'completed'", [trader.userId]).then((r) => Number(r[0].count)),
      1,
    )
  })

  test('a foreign internal reference cannot settle or credit another account', { skip }, async () => {
    const trader = await createTestUser({})
    const other = await createTestUser({})
    const mine = await createDepositPayment({ userId: trader.userId, amountPaise: 50_000, method: 'upi', requestKey: 'stale-a' })
    const theirs = await createDepositPayment({ userId: other.userId, amountPaise: 50_000, method: 'upi', requestKey: 'stale-b' })

    const providerIdOf = async (paymentId: string) =>
      (await rawSql<{ provider_payment_id: string }>('select provider_payment_id from payment_intent where id = $1', [paymentId]))[0].provider_payment_id
    const myProviderId = await providerIdOf(mine.paymentId)
    const theirProviderId = await providerIdOf(theirs.paymentId)
    const before = await accountState(trader.userId)
    const beforeOther = await accountState(other.userId)

    // Correct signature, correct amount, correct currency, the right PROVIDER
    // payment id — but the event echoes a DIFFERENT internal payment in
    // `internal_reference`. The association is verified before any state
    // transition, so this must settle nothing on either side.
    const forMineNamingTheirs = await deliverWebhook(
      (() => {
        const event = sandboxEvent({
          type: 'payment.succeeded',
          paymentId: myProviderId,
          internalReference: theirs.paymentId,
          amountPaise: 50_000,
          eventId: 'evt_foreign_association_a',
        })
        return { rawBody: event.rawBody, headers: event.headers }
      })(),
    )
    assert.ok(forMineNamingTheirs.status < 500, 'the delivery is handled, not crashed')

    const forTheirsNamingMine = await deliverWebhook(
      (() => {
        const event = sandboxEvent({
          type: 'payment.succeeded',
          paymentId: theirProviderId,
          internalReference: mine.paymentId,
          amountPaise: 50_000,
          eventId: 'evt_foreign_association_b',
        })
        return { rawBody: event.rawBody, headers: event.headers }
      })(),
    )
    assert.ok(forTheirsNamingMine.status < 500, 'the delivery is handled, not crashed')

    assert.deepEqual(await accountState(trader.userId), before, 'a foreign association must not credit our account')
    assert.deepEqual(await accountState(other.userId), beforeOther, "a foreign association must not credit another user's account")

    // Control: the very same event WITHOUT the forged association settles
    // normally, which proves the two deliveries above were refused for the
    // association and not because the event was invalid for some other reason.
    const legitimate = sandboxEvent({
      type: 'payment.succeeded',
      paymentId: myProviderId,
      internalReference: mine.paymentId,
      amountPaise: 50_000,
      eventId: 'evt_foreign_association_control',
    })
    assert.ok((await deliverWebhook({ rawBody: legitimate.rawBody, headers: legitimate.headers })).status < 500)
    assert.equal((await accountState(trader.userId)).availablePaise, Number(before.availablePaise) + 50_000, 'exactly one legitimate credit')
    assert.deepEqual(await accountState(other.userId), beforeOther, 'and nothing at all for the other account')
  })

  test('a fabricated transaction id cannot be refunded', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    await signIn(admin.userId)

    for (const transactionId of ['txn_does_not_exist', '../../../etc/passwd', 'x'.repeat(500)]) {
      const response = await adminRefund(jsonRequest('/api/admin/wallet/refund', { transactionId, reason: 'attack' }))
      assert.ok(response.status >= 400, `refund of ${transactionId.slice(0, 20)} must be refused`)
    }
    assert.equal(
      await rawSql<{ count: string }>("select count(*)::text as count from \"transaction\" where type = 'refund'").then((r) => Number(r[0].count)),
      0,
    )
  })

  test('a refund cannot be replayed to reverse a wallet twice', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    const trader = await createTestUser({})
    const deposit = await createDepositPayment({ userId: trader.userId, amountPaise: 50_000, method: 'upi', requestKey: 'refund-replay' })
    const providerPaymentId = (await rawSql<{ provider_payment_id: string }>('select provider_payment_id from payment_intent where id = $1', [deposit.paymentId]))[0].provider_payment_id
    await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000 }))

    const [transaction] = await db.select().from(transactions).where(eq(transactions.userId, trader.userId))
    await signIn(admin.userId)

    const first = await adminRefund(jsonRequest('/api/admin/wallet/refund', { transactionId: transaction.id, reason: 'customer request' }))
    assert.equal(first.status, 200)

    // The sandbox provider confirms the reversal asynchronously, so settle it the
    // way a real provider would and prove the debit happened exactly once.
    const [refund] = await rawSql<{ provider_payment_id: string | null }>(
      "select provider_payment_id from payment_intent where direction = 'refund' and user_id = $1",
      [trader.userId],
    )
    const outcome = providerOutcomeWebhook(refund.provider_payment_id as string, 'succeeded')
    await deliverWebhook({ rawBody: outcome.rawBody, headers: outcome.headers })
    const walletAfterRefund = await readWallet(trader.userId)
    assert.equal(Number(walletAfterRefund.availablePaise), 0, 'the deposit credit was really reversed')

    const second = await adminRefund(jsonRequest('/api/admin/wallet/refund', { transactionId: transaction.id, reason: 'again' }))
    assert.equal(second.status, 409, 'a second refund must be refused as a conflict')
    const walletAfterSecond = await readWallet(trader.userId)
    assert.equal(walletAfterSecond.availablePaise, walletAfterRefund.availablePaise, 'the wallet must not move twice')
    assert.equal(
      await rawSql<{ count: string }>("select count(*)::text as count from \"transaction\" where user_id = $1 and type = 'refund'", [trader.userId]).then((r) => Number(r[0].count)),
      1,
      'exactly one refund transaction exists',
    )
  })

  test('a settled payment cannot be re-driven into a second credit', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    const trader = await createTestUser({})
    const deposit = await createDepositPayment({ userId: trader.userId, amountPaise: 50_000, method: 'upi', requestKey: 'retry-settled' })
    const providerPaymentId = (await rawSql<{ provider_payment_id: string }>('select provider_payment_id from payment_intent where id = $1', [deposit.paymentId]))[0].provider_payment_id
    await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000 }))
    const before = await accountState(trader.userId)

    await signIn(admin.userId)
    const { POST: retryRoute } = await import('@/app/api/admin/payments/retry/route')
    const response = await retryRoute(jsonRequest('/api/admin/payments/retry', { paymentId: deposit.paymentId }))
    assert.ok(response.status >= 200, 'the endpoint answers')

    const after = await accountState(trader.userId)
    assert.equal(after.availablePaise, before.availablePaise, 'a retry must never credit a settled payment again')
    assert.equal(after.ledger, before.ledger)
  })
})

/* ------------------------------------------------------------------ *
 * 6. Provider, webhook and event tampering
 * ------------------------------------------------------------------ */

describe('Attack: provider, webhook and event tampering', () => {
  async function pendingDeposit(userId: string, requestKey: string, amountPaise = 50_000) {
    const deposit = await createDepositPayment({ userId, amountPaise, method: 'upi', requestKey })
    const providerPaymentId = (
      await rawSql<{ provider_payment_id: string }>('select provider_payment_id from payment_intent where id = $1', [deposit.paymentId])
    )[0].provider_payment_id
    return { ...deposit, providerPaymentId }
  }

  test('a delivery signed with the wrong secret is rejected and credited nothing', { skip }, async () => {
    const trader = await createTestUser({})
    const { providerPaymentId } = await pendingDeposit(trader.userId, 'wh-wrong-secret')
    const before = await accountState(trader.userId)

    const event = sandboxEvent({
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      amountPaise: 50_000,
      secretOverride: 'not-the-real-secret',
    })
    const response = await paymentsWebhookRoute(
      rawRequest('/api/payments/webhook?provider=sandbox', event.rawBody, { ...event.headers, 'x-predik-provider': 'sandbox' }),
    )
    assert.equal(response.status, 401)
    assert.deepEqual(await accountState(trader.userId), before)
  })

  test('a missing signature is rejected', { skip }, async () => {
    const trader = await createTestUser({})
    const { providerPaymentId } = await pendingDeposit(trader.userId, 'wh-no-signature')
    const before = await accountState(trader.userId)

    const event = sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000, omitSignature: true })
    const response = await paymentsWebhookRoute(
      rawRequest('/api/payments/webhook?provider=sandbox', event.rawBody, { ...event.headers, 'x-predik-provider': 'sandbox' }),
    )
    assert.equal(response.status, 401)
    assert.deepEqual(await accountState(trader.userId), before)
  })

  test('a body tampered with after signing is rejected', { skip }, async () => {
    const trader = await createTestUser({})
    const { providerPaymentId } = await pendingDeposit(trader.userId, 'wh-tampered')
    const before = await accountState(trader.userId)

    const event = sandboxEvent({
      type: 'payment.succeeded',
      paymentId: providerPaymentId,
      amountPaise: 50_000,
      tamperBodyAfterSigning: (body) => body.replace('50000', '500000'),
    })
    const response = await paymentsWebhookRoute(
      rawRequest('/api/payments/webhook?provider=sandbox', event.rawBody, { ...event.headers, 'x-predik-provider': 'sandbox' }),
    )
    assert.equal(response.status, 401)
    assert.deepEqual(await accountState(trader.userId), before)
  })

  test('a correctly signed event claiming a different provider is rejected', { skip }, async () => {
    const trader = await createTestUser({})
    const { providerPaymentId } = await pendingDeposit(trader.userId, 'wh-provider-swap')
    const before = await accountState(trader.userId)

    const event = sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000 })
    const response = await paymentsWebhookRoute(
      rawRequest('/api/payments/webhook', event.rawBody, { ...event.headers, 'x-predik-provider': 'razorpay' }),
    )
    assert.ok(response.status >= 400, 'the signature only validates for the provider that issued it')
    assert.deepEqual(await accountState(trader.userId), before)
  })

  test('an unknown provider is rejected', { skip }, async () => {
    const trader = await createTestUser({})
    const { providerPaymentId } = await pendingDeposit(trader.userId, 'wh-unknown-provider')
    const event = sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000 })
    const response = await paymentsWebhookRoute(
      rawRequest('/api/payments/webhook', event.rawBody, { ...event.headers, 'x-predik-provider': 'totally-made-up' }),
    )
    assert.ok(response.status >= 400)
  })

  test('a signed event claiming a larger amount is flagged, never credited', { skip }, async () => {
    const trader = await createTestUser({})
    const { providerPaymentId } = await pendingDeposit(trader.userId, 'wh-amount-tamper', 50_000)
    const before = await accountState(trader.userId)

    const event = sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 5_000_000 })
    const result = await deliverWebhook({ rawBody: event.rawBody, headers: event.headers })
    assert.ok(result.status < 500, 'handled, not crashed')

    const after = await accountState(trader.userId)
    assert.equal(after.availablePaise, before.availablePaise, 'a mismatched amount must never be credited')
    const rows = await rawSql<{ reconciliation_status: string }>('select reconciliation_status from payment_intent where provider_payment_id = $1', [providerPaymentId])
    assert.equal(rows[0].reconciliation_status, 'mismatch', 'it must be queued for controlled review')
  })

  test('a signed event claiming a different currency is refused', { skip }, async () => {
    const trader = await createTestUser({})
    const { providerPaymentId } = await pendingDeposit(trader.userId, 'wh-currency')
    const before = await accountState(trader.userId)

    const event = sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000, currency: 'USD' })
    await deliverWebhook({ rawBody: event.rawBody, headers: event.headers })
    assert.deepEqual(await accountState(trader.userId), before)
  })

  test('an unsigned event id from another payment cannot settle this one', { skip }, async () => {
    const trader = await createTestUser({})
    const { paymentId } = await pendingDeposit(trader.userId, 'wh-unknown-payment')
    const before = await accountState(trader.userId)

    const event = sandboxEvent({ type: 'payment.succeeded', paymentId: `pay_does_not_exist_${randomUUID()}`, amountPaise: 50_000 })
    const result = await deliverWebhook({ rawBody: event.rawBody, headers: event.headers })
    assert.ok(result.status < 500)
    assert.deepEqual(await accountState(trader.userId), before)

    const [stored] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, paymentId))
    assert.equal(stored.status, 'pending', 'our payment stays pending')
  })

  test('an authorized (uncaptured) event never credits a deposit', { skip }, async () => {
    const trader = await createTestUser({})
    const { providerPaymentId } = await pendingDeposit(trader.userId, 'wh-authorized')
    const before = await accountState(trader.userId)

    // `payment.processing` maps to a non-final provider status.
    await deliverWebhook(sandboxEvent({ type: 'payment.processing', paymentId: providerPaymentId, amountPaise: 50_000 }))
    const after = await accountState(trader.userId)
    assert.equal(after.availablePaise, before.availablePaise, 'only a captured/succeeded payment credits a wallet')
  })

  test('a client cannot confirm a payment by hitting the sandbox helper directly', { skip }, async () => {
    const attacker = await createTestUser({})
    await signIn(attacker.userId)
    const { POST: sandboxRoute } = await import('@/app/api/admin/payments/sandbox/route')
    const response = await sandboxRoute(jsonRequest('/api/admin/payments/sandbox', { paymentId: 'pay_anything', outcome: 'succeeded' }))
    assert.equal(response.status, 403, 'the sandbox simulator is admin-only')
  })

  test('a webhook that is not JSON at all is handled without a server error', { skip }, async () => {
    const response = await paymentsWebhookRoute(
      rawRequest('/api/payments/webhook?provider=sandbox', 'not-json-at-all', { 'content-type': 'text/plain', 'x-predik-provider': 'sandbox' }),
    )
    assert.ok(response.status >= 400 && response.status < 500, `expected a client error, got ${response.status}`)
  })
})

/* ------------------------------------------------------------------ *
 * 7. Simultaneous requests
 * ------------------------------------------------------------------ */

describe('Attack: simultaneous requests', () => {
  test('five concurrent withdrawals cannot exceed the real balance', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 200_000 })
    await signIn(trader.userId)

    const attempts = Array.from({ length: 5 }, (_, index) =>
      withdrawRoute(
        jsonRequest('/api/wallet/withdraw', { amountPaise: 80_000, destination: `a${index}@upi` }, { 'idempotency-key': `concurrent-withdraw-${index}` }),
      ),
    )
    const results = await Promise.all(attempts)
    const succeeded = results.filter((response) => response.status === 200).length

    assert.ok(succeeded <= 2, `at most two ₹800 withdrawals fit in ₹2,000, got ${succeeded}`)
    const wallet = await readWallet(trader.userId)
    assert.ok(Number(wallet.availablePaise) >= 0, 'available balance must never go negative')
    assert.equal(Number(wallet.availablePaise) + Number(wallet.lockedPaise), 200_000, 'no money may be created or lost')
    assert.equal(Number(wallet.lockedPaise), succeeded * 80_000)
  })

  test('five concurrent deposits under one request key create one payment', { skip }, async () => {
    const trader = await createTestUser({})
    await signIn(trader.userId)

    const attempts = Array.from({ length: 5 }, () =>
      depositRoute(jsonRequest('/api/wallet/deposit', { amountPaise: 50_000, method: 'upi' }, { 'idempotency-key': 'concurrent-deposit-same' })),
    )
    const results = await Promise.all(attempts)
    for (const response of results) assert.equal(response.status, 200)

    const rows = await rawSql<{ count: string; distinct_ids: string }>(
      'select count(*)::text as count, count(distinct id)::text as distinct_ids from payment_intent where user_id = $1',
      [trader.userId],
    )
    assert.equal(Number(rows[0].count), 1, 'one request key, one payment')
    assert.equal(Number(rows[0].distinct_ids), 1)
  })

  test('concurrent conflicting reuse of one request key cannot apply both amounts', { skip }, async () => {
    const trader = await createTestUser({})
    await signIn(trader.userId)

    const [small, large] = await Promise.all([
      depositRoute(jsonRequest('/api/wallet/deposit', { amountPaise: 50_000, method: 'upi' }, { 'idempotency-key': 'concurrent-conflict' })),
      depositRoute(jsonRequest('/api/wallet/deposit', { amountPaise: 150_000, method: 'upi' }, { 'idempotency-key': 'concurrent-conflict' })),
    ])

    const allowed = [small, large].filter((response) => response.status === 200).length
    const rows = await rawSql<{ amount_paise: string }>('select amount_paise from payment_intent where user_id = $1', [trader.userId])
    assert.equal(rows.length, 1, 'exactly one payment may exist for the key')
    assert.equal(allowed, 1, 'and only one of the two conflicting requests may be served')
  })

  test('eight simultaneous deliveries of one event credit exactly once', { skip }, async () => {
    const trader = await createTestUser({})
    const deposit = await createDepositPayment({ userId: trader.userId, amountPaise: 50_000, method: 'upi', requestKey: 'concurrent-webhook' })
    const providerPaymentId = (await rawSql<{ provider_payment_id: string }>('select provider_payment_id from payment_intent where id = $1', [deposit.paymentId]))[0].provider_payment_id

    const event = sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000, eventId: 'evt_concurrent_once' })
    const results = await Promise.all(Array.from({ length: 8 }, () => deliverWebhook({ rawBody: event.rawBody, headers: event.headers })))
    for (const result of results) assert.ok(result.status < 500, 'concurrent duplicates must be handled, not crashed')

    const wallet = await readWallet(trader.userId)
    assert.equal(Number(wallet.availablePaise), 50_000, 'exactly one credit')
    assert.equal(
      await rawSql<{ count: string }>("select count(*)::text as count from ledger_entry where user_id = $1 and status = 'completed'", [trader.userId]).then((r) => Number(r[0].count)),
      1,
      'exactly one ledger movement',
    )
  })

  test('concurrent refunds reverse the wallet once', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    const trader = await createTestUser({})
    const deposit = await createDepositPayment({ userId: trader.userId, amountPaise: 50_000, method: 'upi', requestKey: 'concurrent-refund' })
    const providerPaymentId = (await rawSql<{ provider_payment_id: string }>('select provider_payment_id from payment_intent where id = $1', [deposit.paymentId]))[0].provider_payment_id
    await deliverWebhook(sandboxEvent({ type: 'payment.succeeded', paymentId: providerPaymentId, amountPaise: 50_000 }))

    const [transaction] = await db.select().from(transactions).where(eq(transactions.userId, trader.userId))
    await signIn(admin.userId)

    const results = await Promise.all(
      Array.from({ length: 4 }, () => adminRefund(jsonRequest('/api/admin/wallet/refund', { transactionId: transaction.id, reason: 'concurrent' }))),
    )
    // Exactly one call issues the refund; every other call is an idempotent
    // replay and is reported as a conflict rather than as a fresh reversal.
    assert.equal(results.filter((response) => response.status === 200).length, 1, 'exactly one refund may be issued')
    assert.equal(results.filter((response) => response.status === 409).length, 3, 'the replays must be reported as conflicts')

    const refunds = await rawSql<{ id: string; provider_payment_id: string | null }>(
      "select id, provider_payment_id from payment_intent where direction = 'refund' and user_id = $1",
      [trader.userId],
    )
    assert.equal(refunds.length, 1, 'exactly one refund intent exists, however many times it was requested')

    // The sandbox provider confirms reversals asynchronously, so the debit lands
    // when the provider event does — and it must land exactly once even though
    // four admins asked for the reversal at the same moment.
    const outcome = providerOutcomeWebhook(refunds[0].provider_payment_id as string, 'succeeded')
    await deliverWebhook({ rawBody: outcome.rawBody, headers: outcome.headers })

    const wallet = await readWallet(trader.userId)
    assert.equal(Number(wallet.availablePaise), 0, 'the credit was reversed once, not four times')
    assert.equal(
      await rawSql<{ count: string }>("select count(*)::text as count from \"transaction\" where user_id = $1 and type = 'refund'", [trader.userId]).then((r) => Number(r[0].count)),
      1,
      'exactly one refund transaction is booked',
    )
  })
})
