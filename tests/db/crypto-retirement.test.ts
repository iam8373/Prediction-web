import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { categories, marketOutcomes, markets, positions } from '@/lib/db/schema'
import { retireCryptoMarkets } from '@/lib/db/retire-crypto'
import {
  auditRowsFor,
  closePool,
  createTestUser,
  databaseUrl,
  ledgerForUser,
  notificationsForUser,
  readWallet,
  resetDatabase,
  transactionsForUser,
} from './harness.ts'

const url = databaseUrl()
const skip = url ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'

const CRYPTO_MARKET = 'crypto_retire_test'
const CONTROL_MARKET = 'cricket_keep_test'
/** 64,000 milli-shares at 520 paise ⇒ a cost basis of exactly 33,280 paise. */
const SHARES = 64_000
const AVERAGE_PRICE = 520
const COST_BASIS_PAISE = 33_280

/** The holder created in the first test, reused by the idempotency check. */
let holderUserId = ''

async function insertMarket(id: string, categoryId: string, slug: string) {
  const now = Date.now()
  await db.insert(markets).values({
    id,
    slug,
    question: `Retirement fixture ${id}?`,
    headline: `Fixture ${id}`,
    description: 'Fixture market used by the retirement suite.',
    resolutionCriteria: 'Not applicable: this market exists only for the test.',
    source: 'Test fixture',
    categoryId,
    kind: 'binary',
    status: 'open',
    emblem: 'TST',
    live: false,
    featured: false,
    bonus: false,
    createdAt: now - 86_400_000,
    opensAt: now - 86_400_000,
    closesAt: now + 86_400_000,
    resolvesAt: now + 86_400_000,
    volumePaise: 0,
    liquidityPaise: 100_000,
    traders: 0,
  })
  await db.insert(marketOutcomes).values([
    { id: `${id}:yes`, marketId: id, name: 'Yes', side: 'yes', pricePaise: 500, previousPricePaise: 500 },
    { id: `${id}:no`, marketId: id, name: 'No', side: 'no', pricePaise: 500, previousPricePaise: 500 },
  ])
}

describe('crypto retirement', { skip }, () => {
  before(async () => {
    await resetDatabase()
    await db.insert(categories).values([
      { id: 'crypto', name: 'Crypto', slug: 'crypto', icon: 'Bitcoin', accent: 'oklch(0.74 0.16 65)' },
      { id: 'cricket', name: 'Cricket', slug: 'cricket', icon: 'Trophy', accent: 'oklch(0.72 0.15 167)' },
    ])
    await insertMarket(CRYPTO_MARKET, 'crypto', 'crypto-retire-test')
    await insertMarket(CONTROL_MARKET, 'cricket', 'cricket-keep-test')
  })

  after(async () => {
    await closePool()
  })

  test('refunds an open position at cost, then removes the market and the category', async () => {
    const { userId } = await createTestUser({ availablePaise: 1_000_000 })
    holderUserId = userId
    await db.insert(positions).values({
      id: 'position_retire_test',
      userId,
      marketId: CRYPTO_MARKET,
      outcomeId: `${CRYPTO_MARKET}:yes`,
      milliShares: SHARES,
      averagePricePaise: AVERAGE_PRICE,
      realisedPnlPaise: 0,
      status: 'open',
      createdAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 3_600_000,
    })

    const result = await retireCryptoMarkets()
    assert.equal(result.retiredMarkets, 1, 'the crypto market is withdrawn')
    assert.equal(result.refundedPositions, 1, 'the open position is refunded')
    assert.equal(result.refundedPaise, COST_BASIS_PAISE, 'the refund is exactly the cost basis')

    // Money: the wallet moved by the cost basis and nothing else.
    const wallet = await readWallet(userId)
    assert.equal(wallet.availablePaise, 1_000_000 + COST_BASIS_PAISE)

    // Both ledger rows exist, agree, and carry the same reference.
    const [transaction] = await transactionsForUser(userId)
    const [entry] = await ledgerForUser(userId)
    assert.equal(transaction.type, 'refund')
    assert.equal(transaction.amountPaise, COST_BASIS_PAISE)
    assert.equal(entry.amountPaise, COST_BASIS_PAISE)
    assert.equal(entry.reference, transaction.reference)
    assert.equal(transaction.marketId, CRYPTO_MARKET)

    // The position is closed flat: a withdrawal is not a win and not a loss.
    const [position] = await db.select().from(positions).where(eq(positions.id, 'position_retire_test'))
    assert.equal(position.status, 'settled')
    assert.equal(position.realisedPnlPaise, 0, 'a withdrawal must not book a profit or a loss')

    const notifications = await notificationsForUser(userId)
    assert.equal(notifications.length, 1, 'the holder is told why their stake came back')

    // The market, its outcomes and the category are gone.
    assert.equal((await db.select().from(markets).where(eq(markets.id, CRYPTO_MARKET))).length, 0)
    assert.equal((await db.select().from(marketOutcomes).where(eq(marketOutcomes.marketId, CRYPTO_MARKET))).length, 0)
    assert.equal((await db.select().from(categories).where(eq(categories.id, 'crypto'))).length, 0)

    // Unrelated markets are untouched.
    assert.equal((await db.select().from(markets).where(eq(markets.id, CONTROL_MARKET))).length, 1)
    assert.equal((await db.select().from(categories).where(eq(categories.id, 'cricket'))).length, 1)

    const audit = await auditRowsFor('crypto')
    assert.equal(audit.length, 1, 'withdrawing a market that held balances is audited')
    assert.equal(audit[0].actor_role, 'system')
  })

  test('is idempotent: a second run moves no money', async () => {
    const walletBefore = await readWallet(holderUserId)
    const positionsBefore = await db.select().from(positions)

    const result = await retireCryptoMarkets()

    assert.equal(result.retiredMarkets, 0)
    assert.equal(result.refundedPositions, 0)
    assert.equal(result.refundedPaise, 0)
    assert.equal((await db.select().from(positions)).length, positionsBefore.length)
    assert.deepEqual(await readWallet(holderUserId), walletBefore, 'no second refund is credited')

    // Exactly one refund row, from the first run.
    const transactions = await transactionsForUser(holderUserId)
    assert.equal(transactions.length, 1)
    assert.equal(transactions[0].amountPaise, COST_BASIS_PAISE)
  })

  test('the retired category cannot be selected', async () => {
    const rows = await db.select().from(categories)
    assert.deepEqual(rows.map((row) => row.id), ['cricket'])
  })
})
