import 'server-only'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { POST as resolveMarket } from '@/app/api/admin/markets/resolve/route'
import { POST as buyRoute } from '@/app/api/trading/buy/route'
import { POST as sellRoute } from '@/app/api/trading/sell/route'
import { POST as withdrawRoute } from '@/app/api/wallet/withdraw/route'
import { createSession, DEMO_OTP, requestOtp, verifyOtp } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { ledgerEntries, marketOutcomes, markets, positions, sessions, trades, transactions, users } from '@/lib/db/schema'
import { requireAdmin } from '@/lib/security/admin-guard'
import { guardRequest } from '@/lib/security/guard'
import { consumeRateLimit, enforceRateLimit, RATE_LIMITS } from '@/lib/security/rate-limit'
import { __resetRequestCookies, __setRequestCookies } from '../stubs/next-headers.mjs'
import { closePool, createTestUser, databaseUrl, rawSql, readWallet, resetDatabase } from './harness.ts'

/**
 * Runtime security suite: authorization, rate limiting and immutability against
 * a real database.
 *
 * Everything here runs against a real PostgreSQL database and drives the real
 * modules — the exported route handlers, the admin gate, the rate limiter and
 * the database triggers — rather than mocks. The tests call the actual route
 * handlers with real `Request` objects and a real session row, so a broken
 * authorization or locking path cannot pass by accident.
 */

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'

before(async () => {
  if (skip) return
  await resetDatabase()
})

after(async () => {
  __resetRequestCookies()
  await closePool()
})

afterEach(() => {
  __resetRequestCookies()
  delete process.env.RATE_LIMIT_ACCOUNT_READ_LIMIT
  delete process.env.RATE_LIMIT_WITHDRAWAL_LIMIT
  delete process.env.RATE_LIMIT_OTP_VERIFY_FAILED_GLOBAL_LIMIT
  delete process.env.ADMIN_PHONES
})

const API = 'https://app.predik.test'

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Signs a user in for the duration of a test (the session lives in the database). */
async function signIn(userId: string) {
  const token = await createSession(userId)
  __setRequestCookies({ predik_session: token })
  return token
}

let marketCounter = 0

/** Builds an open market with a YES/NO outcome pair and a seeded position. */
async function createMarketWithPosition(input: { userId: string; milliShares: number; yesPricePaise?: number }) {
  marketCounter += 1
  const id = `market_sec_${process.pid}_${marketCounter}_${randomUUID().slice(0, 6)}`
  const now = Date.now()
  const yesPrice = input.yesPricePaise ?? 500
  await db.insert(markets).values({
    id,
    slug: `${id}-slug`,
    question: `Security harness market ${marketCounter}?`,
    headline: 'Yes vs No',
    description: 'Created by the security suite.',
    resolutionCriteria: 'Resolved by the security suite.',
    source: 'security test suite',
    categoryId: 'cat_test',
    kind: 'binary',
    status: 'open',
    emblem: 'SEC',
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
  if (input.milliShares > 0) {
    await db.insert(positions).values({
      id: `pos_sec_${marketCounter}_${randomUUID().slice(0, 6)}`,
      userId: input.userId,
      marketId: id,
      outcomeId: `${id}:yes`,
      milliShares: input.milliShares,
      averagePricePaise: yesPrice,
      realisedPnlPaise: 0,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    })
  }
  return { marketId: id, yesOutcomeId: `${id}:yes` }
}

const countRows = async (sqlText: string, values: unknown[]) => {
  const rows = await rawSql<{ count: string }>(sqlText, values)
  return Number(rows[0]?.count ?? '0')
}

describe('Admin authorization is enforced from the database, not the client', () => {
  test('an unauthenticated caller is refused with 401 and the refusal is recorded', { skip }, async () => {
    const before = await countRows("select count(*)::text as count from audit_log where action = 'security.auth.unauthenticated'", [])
    // An empty cookie jar: a real request with no session cookie.
    __setRequestCookies({})

    const guard = await requireAdmin(new Request(`${API}/api/admin/payments`), { scope: 'test.unauthenticated' })
    assert.equal(guard.ok, false)
    if (guard.ok) return
    assert.equal(guard.response.status, 401)
    assert.deepEqual(await guard.response.json(), { ok: false, error: 'Sign in with an admin account' })

    const after = await countRows("select count(*)::text as count from audit_log where action = 'security.auth.unauthenticated'", [])
    assert.equal(after, before + 1, 'a refused privileged request must be reviewable afterwards')
  })

  test('a signed-in non-admin is refused with 403 and the refusal is recorded', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 1000 })
    await signIn(trader.userId)

    const guard = await requireAdmin(new Request(`${API}/api/admin/payments`), { scope: 'test.nonadmin' })
    assert.equal(guard.ok, false)
    if (guard.ok) return
    assert.equal(guard.response.status, 403)

    const rows = await rawSql<{ outcome: string }>(
      "select metadata->>'outcome' as outcome from audit_log where action = 'security.authz.denied' and actor_user_id = $1",
      [trader.userId],
    )
    assert.ok(rows.length >= 1, 'a privilege-escalation attempt must be logged against the account')
    assert.equal(rows[0].outcome, 'denied')
  })

  test('an admin session is accepted', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    await signIn(admin.userId)

    const guard = await requireAdmin(new Request(`${API}/api/admin/payments`), { scope: 'test.admin' })
    assert.equal(guard.ok, true)
    if (guard.ok) assert.equal(guard.admin.id, admin.userId)
  })

  test('an expired session is treated as unauthenticated and revoked', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    const token = randomUUID().replace(/-/g, '')
    await db.insert(sessions).values({ token, userId: admin.userId, expiresAt: new Date(Date.now() - 60_000) })
    __setRequestCookies({ predik_session: token })

    const guard = await requireAdmin(new Request(`${API}/api/admin/payments`), { scope: 'test.expired' })
    assert.equal(guard.ok, false)
    if (!guard.ok) assert.equal(guard.response.status, 401)

    assert.equal(await countRows('select count(*)::text as count from session where token = $1', [token]), 0, 'an expired session must not survive its first use')
  })

  test('a request with no readable cookie scope is treated as unauthenticated, not as a server error', { skip }, async () => {
    __resetRequestCookies()
    const guard = await requireAdmin(new Request(`${API}/api/admin/payments`), { scope: 'test.noscope' })
    assert.equal(guard.ok, false)
    if (!guard.ok) assert.equal(guard.response.status, 401, 'a missing session scope must fail closed')
  })

  test('a forged session token is refused', { skip }, async () => {
    __setRequestCookies({ predik_session: 'not-a-real-session-token' })
    const guard = await requireAdmin(new Request(`${API}/api/admin/payments`), { scope: 'test.forged' })
    assert.equal(guard.ok, false)
    if (!guard.ok) assert.equal(guard.response.status, 401)
  })

  test('a client cannot declare itself an admin through the request', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 1000 })
    await signIn(trader.userId)

    const attempts = [
      jsonRequest('/api/admin/payments', { isAdmin: true }, { 'x-admin': 'true', 'x-user-role': 'admin' }),
      new Request(`${API}/api/admin/payments?isAdmin=true&role=admin`),
      new Request(`${API}/api/admin/payments`, { headers: { 'x-forwarded-user': trader.userId, 'x-user-id': trader.userId } }),
    ]
    for (const request of attempts) {
      const guard = await requireAdmin(request, { scope: 'test.spoof' })
      assert.equal(guard.ok, false, 'no client-supplied value may grant admin access')
      if (!guard.ok) assert.equal(guard.response.status, 403)
    }
  })

  test('the real admin route refuses a normal user and accepts an admin', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 5000 })
    await signIn(trader.userId)

    const refused = await resolveMarket(jsonRequest('/api/admin/markets/resolve', { marketId: 'x', outcomeId: 'x:yes' }))
    assert.equal(refused.status, 403, 'the admin market route must refuse a normal user')

    const admin = await createTestUser({ isAdmin: true })
    await signIn(admin.userId)
    const allowed = await resolveMarket(jsonRequest('/api/admin/markets/resolve', { marketId: 'x', outcomeId: 'x:yes' }))
    assert.equal(allowed.status, 404, 'the admin gets past authorization and fails on the unknown market instead')
  })
})

describe('Sign-in guessing is bounded across every account, not just one phone', () => {
  test('failed verifications on different numbers spend one shared budget', { skip }, async () => {
    // A deployment-issued code is the same for everybody, so guessing it against
    // fresh phone numbers never trips a per-phone limit. The shared budget is
    // what makes that enumeration cost something.
    process.env.RATE_LIMIT_OTP_VERIFY_FAILED_GLOBAL_LIMIT = '3'
    const { POST: otpRoute } = await import('@/app/api/auth/otp/route')
    const attempt = (phone: string) =>
      otpRoute(jsonRequest('/api/auth/otp', { action: 'verify', phone, otp: '000000' }, { origin: API }))

    for (const [index, phone] of ['9876501001', '9876501002', '9876501003'].entries()) {
      const response = await attempt(phone)
      assert.equal(response.status, 400, `attempt ${index + 1} on a fresh number is a wrong-code rejection`)
    }

    const blocked = await attempt('9876501004')
    assert.equal(blocked.status, 429, 'the shared budget must block further verification')
    assert.ok(blocked.headers.get('retry-after'), 'a caller is told when to try again')

    // The block is a budget, not a ban: it expires with its window.
    delete process.env.RATE_LIMIT_OTP_VERIFY_FAILED_GLOBAL_LIMIT
    assert.equal((await attempt('9876501005')).status, 400, 'raising the limit lifts the block')
  })
})

describe('Admin privilege follows configuration on every sign-in', () => {
  test('a number removed from the allowlist loses admin at its next sign-in', { skip }, async () => {
    const phone = '9876502001'
    await requestOtp(phone)
    const trader = await verifyOtp(phone, DEMO_OTP)
    assert.equal(trader.isAdmin, false, 'a number that is not configured is not an admin')

    // An operator grants it (or it was configured when the account was created).
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, trader.id))
    const [promoted] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, trader.id))
    assert.equal(promoted.isAdmin, true)

    // Taking the number off the allowlist must take effect without an operator
    // having to remember this account: the next sign-in demotes it.
    await requestOtp(phone)
    const demoted = await verifyOtp(phone, DEMO_OTP)
    assert.equal(demoted.isAdmin, false, 'privilege must not survive removal from the allowlist')

    // And putting it back on grants it again — the allowlist is authoritative in
    // both directions.
    process.env.ADMIN_PHONES = phone
    await requestOtp(phone)
    const regranted = await verifyOtp(phone, DEMO_OTP)
    assert.equal(regranted.isAdmin, true)
  })
})

describe('Server-side rate limiting', () => {
  test('concurrent requests cannot both pass a single-unit budget', { skip }, async () => {
    process.env.RATE_LIMIT_ACCOUNT_READ_LIMIT = '1'
    const key = `user:ratelimit:${randomUUID()}`

    const [first, second] = await Promise.all([
      consumeRateLimit({ bucket: 'accountRead', key }),
      consumeRateLimit({ bucket: 'accountRead', key }),
    ])

    assert.equal(
      [first.count, second.count].sort((a, b) => a - b).join(','),
      '1,2',
      'the counter increment must be atomic, not read-then-write',
    )
    assert.equal([first.allowed, second.allowed].filter(Boolean).length, 1, 'exactly one request may pass')
  })

  test('a spent budget is refused with 429 and a Retry-After', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    await signIn(admin.userId)
    process.env.RATE_LIMIT_ACCOUNT_READ_LIMIT = '1'

    const first = await requireAdmin(new Request(`${API}/api/admin/payments`), { bucket: 'accountRead', scope: 'test.ratelimit' })
    assert.equal(first.ok, true, 'the first request inside the budget is allowed')

    const second = await requireAdmin(new Request(`${API}/api/admin/payments`), { bucket: 'accountRead', scope: 'test.ratelimit' })
    assert.equal(second.ok, false)
    if (!second.ok) {
      assert.equal(second.response.status, 429)
      assert.ok(second.response.headers.get('retry-after'), 'the client must be told when to retry')
    }
  })

  test('withdrawal spam is throttled and reserves nothing', { skip }, async () => {
    process.env.RATE_LIMIT_WITHDRAWAL_LIMIT = '1'
    const user = await createTestUser({ availablePaise: 100_000 })
    await signIn(user.userId)

    const first = await withdrawRoute(jsonRequest('/api/wallet/withdraw', { amountPaise: 20_000, destination: 'a@upi' }))
    assert.equal(first.status, 200)

    const second = await withdrawRoute(jsonRequest('/api/wallet/withdraw', { amountPaise: 20_000, destination: 'a@upi' }))
    assert.equal(second.status, 429, 'a second withdrawal in the same window must be throttled')

    const wallet = await readWallet(user.userId)
    assert.equal(Number(wallet.availablePaise), 80_000, 'the throttled request must not have reserved anything')
    assert.ok(RATE_LIMITS.withdrawal.limit <= RATE_LIMITS.trade.limit, 'withdrawals must be tighter than trading')
  })

  test('the counter table stores no raw identifier', { skip }, async () => {
    const phone = '9876512345'
    await consumeRateLimit({ bucket: 'otpRequestPhone', key: `phone:${phone}` })
    const rows = await rawSql<{ key_hash: string }>(
      "select key_hash from rate_limit_counter where bucket = 'otpRequestPhone'",
    )
    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.equal(row.key_hash.includes(phone), false, 'a rate-limit row must never contain the phone number')
      assert.match(row.key_hash, /^[a-f0-9]{64}$/)
    }
  })

  test('windows are independent, so a spent window does not block the next', { skip }, async () => {
    const key = `user:windows:${randomUUID()}`
    const firstWindow = await consumeRateLimit({ bucket: 'accountRead', key, now: 1_000_000 })
    const secondWindow = await consumeRateLimit({
      bucket: 'accountRead',
      key,
      now: 1_000_000 + RATE_LIMITS.accountRead.windowMs,
    })
    assert.equal(firstWindow.count, 1)
    assert.equal(secondWindow.count, 1, 'a new window starts from zero')
    assert.ok(secondWindow.resetAt > firstWindow.resetAt)
  })

  test('the limiter is a real guard: it throws when the budget is gone', { skip }, async () => {
    process.env.RATE_LIMIT_ACCOUNT_READ_LIMIT = '1'
    const key = `user:throws:${randomUUID()}`
    await enforceRateLimit({ bucket: 'accountRead', key })
    await assert.rejects(() => enforceRateLimit({ bucket: 'accountRead', key }), /RATE_LIMITED/)
  })
})

describe('Request guards applied to a real request', () => {
  test('a cross-site state change is refused with 403', { skip }, async () => {
    const request = jsonRequest('/api/wallet/deposit', { amountPaise: 50_000 }, { origin: 'https://evil.example.com' })
    await assert.rejects(
      () => guardRequest({ request, bucket: 'deposit', key: 'user:x', scope: 'test.csrf' }),
      /CSRF_ORIGIN_REJECTED/,
    )
  })

  test('an oversized body is refused with 413', { skip }, async () => {
    const request = new Request(`${API}/api/wallet/deposit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) },
      body: JSON.stringify({ amountPaise: 50_000 }),
    })
    await assert.rejects(() => guardRequest({ request, scope: 'test.payload' }), /PAYLOAD_TOO_LARGE/)
  })

  test('a same-origin request without an Origin header (server-to-server) is allowed', { skip }, async () => {
    const request = jsonRequest('/api/wallet/deposit', { amountPaise: 50_000 })
    await assert.doesNotReject(() => guardRequest({ request, scope: 'test.sameorigin' }))
  })

  test('the money routes are guarded end to end before any work happens', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 100_000 })
    await signIn(trader.userId)

    const crossSite = await withdrawRoute(
      jsonRequest('/api/wallet/withdraw', { amountPaise: 10_000, destination: 'a@upi' }, { origin: 'https://evil.example.com' }),
    )
    assert.equal(crossSite.status, 403)

    const wallet = await readWallet(trader.userId)
    assert.equal(Number(wallet.availablePaise), 100_000, 'a cross-site attempt must not reserve funds')
    assert.equal(Number(wallet.lockedPaise), 0)
  })
})

describe('Accounting history is append-only in the database itself', () => {
  async function seedAccountingRow() {
    const user = await createTestUser({ availablePaise: 10_000 })
    const id = randomUUID()
    const reference = `SEC-${id.slice(0, 8)}`
    await db.insert(transactions).values({
      id,
      userId: user.userId,
      reference,
      type: 'deposit',
      amountPaise: 10_000,
      status: 'pending',
      description: 'immutability fixture',
      createdAt: Date.now(),
    })
    await db.insert(ledgerEntries).values({
      id: `ledger_${id}`,
      userId: user.userId,
      reference,
      type: 'deposit',
      amountPaise: 10_000,
      status: 'pending',
      description: 'immutability fixture',
      createdAt: Date.now(),
    })
    return { id, ledgerId: `ledger_${id}`, userId: user.userId }
  }

  test('the guard triggers exist on both accounting tables', { skip }, async () => {
    const rows = await rawSql<{ tgname: string }>(
      "select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relname in ('ledger_entry', 'transaction')",
    )
    const names = rows.map((row) => row.tgname)
    assert.ok(names.includes('ledger_entry_immutable'), 'ledger_entry must be protected')
    assert.ok(names.includes('transaction_immutable'), 'transaction must be protected')
  })

  test('a historical amount cannot be rewritten', { skip }, async () => {
    const row = await seedAccountingRow()
    await assert.rejects(() => rawSql('update ledger_entry set amount_paise = 999999 where id = $1', [row.ledgerId]), /append-only/)
    await assert.rejects(() => rawSql('update "transaction" set amount_paise = 999999 where id = $1', [row.id]), /append-only/)

    const stillOriginal = await rawSql<{ amount_paise: string }>('select amount_paise from ledger_entry where id = $1', [row.ledgerId])
    assert.equal(Number(stillOriginal[0].amount_paise), 10_000, 'the value must be exactly what it was')
  })

  test('a history row cannot be deleted', { skip }, async () => {
    const row = await seedAccountingRow()
    await assert.rejects(() => rawSql('delete from ledger_entry where id = $1', [row.ledgerId]), /append-only/)
    await assert.rejects(() => rawSql('delete from "transaction" where id = $1', [row.id]), /append-only/)
  })

  test('ownership, reference, type and timestamps are immutable', { skip }, async () => {
    const row = await seedAccountingRow()
    const other = await createTestUser({})
    const attempts: Array<[string, unknown[]]> = [
      ['update ledger_entry set user_id = $1 where id = $2', [other.userId, row.ledgerId]],
      ['update ledger_entry set reference = $1 where id = $2', ['SOMETHING-ELSE', row.ledgerId]],
      ["update ledger_entry set type = 'bonus' where id = $1", [row.ledgerId]],
      ['update ledger_entry set created_at = 1 where id = $1', [row.ledgerId]],
    ]
    for (const [statement, values] of attempts) {
      await assert.rejects(() => rawSql(statement, values), /append-only|immutable/, `should refuse: ${statement}`)
    }
  })

  test('a pending hold can still settle: only the status column may move', { skip }, async () => {
    const row = await seedAccountingRow()
    await rawSql("update ledger_entry set status = 'completed' where id = $1", [row.ledgerId])
    await rawSql("update \"transaction\" set status = 'completed' where id = $1", [row.id])
    const settled = await rawSql<{ status: string }>('select status from ledger_entry where id = $1', [row.ledgerId])
    assert.equal(settled[0].status, 'completed')
  })
})

describe('Trading concurrency is protected by the database, not by the client', () => {
  test('two simultaneous buys cannot overspend the available balance', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 100_000 })
    await signIn(trader.userId)
    const { marketId, yesOutcomeId } = await createMarketWithPosition({ userId: trader.userId, milliShares: 0 })

    const buy = (key: string) =>
      buyRoute(
        jsonRequest('/api/trading/buy', { marketId, outcomeId: yesOutcomeId, amountPaise: 80_000 }, { 'idempotency-key': key }),
      )
    const [first, second] = await Promise.all([buy('race-buy-a'), buy('race-buy-b')])
    assert.deepEqual([first.status, second.status].sort(), [200, 409], 'exactly one trade may consume the balance')

    const wallet = await readWallet(trader.userId)
    assert.ok(Number(wallet.availablePaise) >= 0, 'available balance must never go negative')
    assert.equal(Number(wallet.availablePaise), 20_000)
    assert.equal(
      await countRows('select count(*)::text as count from "transaction" where user_id = $1 and type = $2', [trader.userId, 'buy']),
      1,
      'one trade, one transaction',
    )
  })

  test('two simultaneous sells cannot oversell a position', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 0 })
    await signIn(trader.userId)
    const { marketId, yesOutcomeId } = await createMarketWithPosition({ userId: trader.userId, milliShares: 5_000 })

    const sell = (key: string) =>
      sellRoute(
        jsonRequest('/api/trading/sell', { marketId, outcomeId: yesOutcomeId, milliShares: 5_000 }, { 'idempotency-key': key }),
      )
    const [first, second] = await Promise.all([sell('race-sell-a'), sell('race-sell-b')])
    assert.deepEqual([first.status, second.status].sort(), [200, 409], 'a position cannot be sold twice')

    const held = await db.select().from(positions).where(eq(positions.userId, trader.userId))
    for (const position of held) {
      assert.ok(Number(position.milliShares) >= 0, 'share count must never go negative')
    }
    assert.equal(await countRows('select count(*)::text as count from trade where user_id = $1 and side = $2', [trader.userId, 'sell']), 1)
  })

  test('a repeated sell with the same request key is applied exactly once', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 0 })
    await signIn(trader.userId)
    const { marketId, yesOutcomeId } = await createMarketWithPosition({ userId: trader.userId, milliShares: 5_000 })

    const body = { marketId, outcomeId: yesOutcomeId, milliShares: 2_000 }
    const headers = { 'idempotency-key': 'repeat-sell-1' }
    const first = await sellRoute(jsonRequest('/api/trading/sell', body, headers))
    const second = await sellRoute(jsonRequest('/api/trading/sell', body, headers))

    assert.equal(first.status, 200)
    assert.equal(second.status, 200, 'a retry of the same request must replay, not fail or duplicate')
    const rows = await db.select().from(trades).where(eq(trades.userId, trader.userId))
    assert.equal(rows.length, 1, 'exactly one trade row')
  })
})

describe('A buy-and-sell round trip cannot create money (real routes)', () => {
  test('buying and immediately selling back leaves the trader down, and the ledger explains it', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 100_000 })
    await signIn(trader.userId)
    const { marketId, yesOutcomeId } = await createMarketWithPosition({ userId: trader.userId, milliShares: 0 })

    const walletBefore = Number((await readWallet(trader.userId)).availablePaise)
    const ledgerBefore = (await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, trader.userId)))
      .reduce((sum, row) => sum + Number(row.amountPaise), 0)

    const buyResponse = await buyRoute(
      jsonRequest('/api/trading/buy', { marketId, outcomeId: yesOutcomeId, amountPaise: 10_000 }, { 'idempotency-key': 'pump-buy' }),
    )
    assert.equal(buyResponse.status, 200)
    const bought = (await buyResponse.json()) as { milliShares: number; quote: { pricePaise: number } }
    assert.ok(
      bought.quote.pricePaise > 500,
      `a buy must fill above the 500 mid, got ${bought.quote.pricePaise}`,
    )

    const sellResponse = await sellRoute(
      jsonRequest('/api/trading/sell', { marketId, outcomeId: yesOutcomeId, milliShares: bought.milliShares }, { 'idempotency-key': 'pump-sell' }),
    )
    assert.equal(sellResponse.status, 200)
    const sold = (await sellResponse.json()) as { quote: { grossValuePaise: number; pricePaise: number } }
    assert.ok(sold.quote.pricePaise < bought.quote.pricePaise, 'a sell must fill below the price the buy paid')
    assert.ok(
      sold.quote.grossValuePaise < 10_000,
      `the round trip returned ${sold.quote.grossValuePaise} for 10_000 paid`,
    )

    const walletAfter = Number((await readWallet(trader.userId)).availablePaise)
    const ledgerAfter = (await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, trader.userId)))
      .reduce((sum, row) => sum + Number(row.amountPaise), 0)

    assert.ok(walletAfter < walletBefore, `the trader ended with ${walletAfter}, started with ${walletBefore}`)
    assert.equal(ledgerAfter - ledgerBefore, walletAfter - walletBefore, 'the wallet moved exactly as the ledger says')

    // And the position is closed, so the loss is realised rather than hidden in
    // an open holding.
    const held = await db.select().from(positions).where(eq(positions.userId, trader.userId))
    for (const position of held) {
      assert.equal(position.status, 'closed')
      assert.equal(Number(position.milliShares), 0)
    }
  })
})

describe('Market resolution is idempotent under concurrency', () => {
  test('two simultaneous resolutions settle the market and pay winners exactly once', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    const trader = await createTestUser({ availablePaise: 0 })
    await signIn(admin.userId)
    const { marketId, yesOutcomeId } = await createMarketWithPosition({ userId: trader.userId, milliShares: 10_000 })

    const resolve = () => resolveMarket(jsonRequest('/api/admin/markets/resolve', { marketId, outcomeId: yesOutcomeId }))
    const [first, second] = await Promise.all([resolve(), resolve()])
    assert.deepEqual([first.status, second.status].sort(), [200, 409], 'a market may only be resolved once')

    const [market] = await db.select().from(markets).where(eq(markets.id, marketId))
    assert.equal(market.status, 'resolved')

    assert.equal(
      await countRows("select count(*)::text as count from ledger_entry where user_id = $1 and type = 'payout'", [trader.userId]),
      1,
      'a winner must be paid exactly once',
    )
    const wallet = await readWallet(trader.userId)
    assert.ok(Number(wallet.availablePaise) > 0, 'the winning position pays out')
  })

  test('a resolved market refuses further trading and moves no money', { skip }, async () => {
    const admin = await createTestUser({ isAdmin: true })
    const trader = await createTestUser({ availablePaise: 100_000 })
    const { marketId, yesOutcomeId } = await createMarketWithPosition({ userId: trader.userId, milliShares: 1_000 })

    await signIn(admin.userId)
    const resolved = await resolveMarket(jsonRequest('/api/admin/markets/resolve', { marketId, outcomeId: yesOutcomeId }))
    assert.equal(resolved.status, 200)

    await signIn(trader.userId)
    const beforeTrade = await readWallet(trader.userId)
    const trade = await buyRoute(
      jsonRequest('/api/trading/buy', { marketId, outcomeId: yesOutcomeId, amountPaise: 10_000 }, { 'idempotency-key': 'post-resolve' }),
    )
    assert.equal(trade.status, 409, 'a resolved market must not accept new trades')

    // The settlement payout from the resolution is legitimate; the refused trade
    // must change nothing on top of it.
    const afterTrade = await readWallet(trader.userId)
    assert.equal(Number(afterTrade.availablePaise), Number(beforeTrade.availablePaise), 'a refused trade must not move money')
    assert.equal(Number(afterTrade.lockedPaise), Number(beforeTrade.lockedPaise))
  })
})

describe('Wallet integrity invariants', () => {
  test('a withdrawal cannot take the wallet below zero', { skip }, async () => {
    const trader = await createTestUser({ availablePaise: 10_000 })
    await signIn(trader.userId)

    const response = await withdrawRoute(jsonRequest('/api/wallet/withdraw', { amountPaise: 900_000, destination: 'a@upi' }))
    assert.ok(response.status >= 400, 'an unaffordable withdrawal must be refused')

    const wallet = await readWallet(trader.userId)
    assert.equal(Number(wallet.availablePaise), 10_000)
    assert.equal(Number(wallet.lockedPaise), 0)
  })

  test('no wallet in the database has a negative bucket', { skip }, async () => {
    assert.equal(
      await countRows(
        'select count(*)::text as violations from wallet where available_paise < 0 or locked_paise < 0 or bonus_paise < 0',
        [],
      ),
      0,
    )
  })
})
