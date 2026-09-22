import 'server-only'

import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { marketOutcomes, markets } from '@/lib/db/schema'
import { resetProviderMarketSync, syncProviderMarkets } from '@/lib/data/provider-markets'
import { resetCricketCache } from '@/lib/providers/cricket'
import { closePool, databaseUrl, resetDatabase, truncateAll } from './harness.ts'

/**
 * The provider sync against the real database.
 *
 * The provider itself is stubbed: what is under test is the write, and in
 * particular the rule that a refresh must never move a price, a volume or a
 * status. That rule is money-visible — resetting a traded price on a timer would
 * be an arbitrage machine — so it is asserted directly rather than assumed.
 */

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'

const realFetch = globalThis.fetch
const KEY = 'test-cricket-key'

let calls = 0

function stubCricket(payload: unknown, status = 200) {
  globalThis.fetch = ((input: unknown) => {
    calls += 1
    assert.ok(String(input).includes('api.cricapi.com'), 'only the stubbed provider is called')
    return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
}

function kickoffIn(hoursFromNow: number) {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString().replace('Z', '')
}

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fixture-1',
    name: 'New Delhi Tigers vs West Delhi Lions',
    matchType: 't20',
    venue: 'Arun Jaitley Stadium',
    dateTimeGMT: kickoffIn(24),
    teams: ['New Delhi Tigers', 'West Delhi Lions'],
    teamInfo: [
      { name: 'New Delhi Tigers', shortname: 'NDT' },
      { name: 'West Delhi Lions', shortname: 'WDL' },
    ],
    series: 'T20 - DPL',
    matchStarted: false,
    matchEnded: false,
    ...overrides,
  }
}

function success(data: unknown[]) {
  return { status: 'success', data, info: { hitsToday: 3, hitsLimit: 100 } }
}

before(async () => {
  if (skip) return
  await resetDatabase()
})

// Every case asserts on the catalogue, so each starts from an empty one.
beforeEach(async () => {
  if (skip) return
  await truncateAll()
})

after(async () => {
  await closePool()
})

afterEach(() => {
  globalThis.fetch = realFetch
  calls = 0
  resetProviderMarketSync()
  // Two caches sit in front of the provider: the sync's own memo and the
  // adapter's TTL list. The suite has to forget both, or a later test silently
  // reads the previous test's fixtures.
  resetCricketCache()
  delete process.env.CRICKETDATA_API_KEY
})

describe('provider market sync', { skip }, () => {
  test('with no provider configured nothing is called and nothing is written', async () => {
    const result = await syncProviderMarkets()
    assert.equal(result.skipped, true)
    assert.equal(calls, 0, 'no provider is contacted without a credential')
    assert.equal((await db.select().from(markets)).length, 0)
  })

  test('a fixture becomes a tradable market at an even price', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    stubCricket(success([fixture()]))

    const result = await syncProviderMarkets()

    assert.equal(result.inserted, 1)
    assert.equal(result.updated, 0)
    assert.deepEqual(result.failures, [])

    const [market] = await db.select().from(markets).where(eq(markets.id, 'cd_fixture-1'))
    assert.ok(market, 'the fixture is now a market')
    assert.equal(market.categoryId, 'cricket')
    assert.equal(market.kind, 'match')
    assert.equal(market.status, 'open')
    assert.equal(market.question, 'Will New Delhi Tigers beat West Delhi Lions in the T20?')
    assert.ok(market.liquidityPaise > 0, 'a market needs depth for the pricing function')
    assert.equal(market.volumePaise, 0)
    assert.equal(market.traders, 0)

    const outcomes = await db.select().from(marketOutcomes).where(eq(marketOutcomes.marketId, market.id))
    assert.equal(outcomes.length, 2)
    assert.equal(outcomes[0].pricePaise + outcomes[1].pricePaise, 1000, 'the pair is priced out of 1000')
  })

  test('a refresh never resets a traded price, volume or status', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    stubCricket(success([fixture()]))
    await syncProviderMarkets()

    // Simulate a traded market: a moved price, recorded volume, and an admin
    // who paused it.
    await db.update(marketOutcomes).set({ pricePaise: 610 }).where(eq(marketOutcomes.id, 'cd_fixture-1:yes'))
    await db.update(markets).set({ volumePaise: 512_300, traders: 41, status: 'paused' }).where(eq(markets.id, 'cd_fixture-1'))

    // The fixture is rescheduled and renamed, then re-synced. In production the
    // adapter's 30-minute TTL is what brings a reschedule in; here it is cleared
    // explicitly rather than waited for.
    const rescheduled = kickoffIn(48)
    stubCricket(success([fixture({ dateTimeGMT: rescheduled, venue: 'Feroz Shah Kotla' })]))
    resetCricketCache()
    resetProviderMarketSync()
    const result = await syncProviderMarkets()

    assert.equal(result.updated, 1)
    assert.equal(result.inserted, 0)

    const [market] = await db.select().from(markets).where(eq(markets.id, 'cd_fixture-1'))
    assert.equal(market.volumePaise, 512_300, 'volume is application state, not fixture state')
    assert.equal(market.traders, 41)
    assert.equal(market.status, 'paused', 'a human decision survives a refresh')
    assert.match(market.description, /Feroz Shah Kotla/, 'descriptive fields do refresh')
    assert.equal(market.closesAt, Date.parse(rescheduled), 'a rescheduled fixture moves its close time')

    const [yes] = await db.select().from(marketOutcomes).where(eq(marketOutcomes.id, 'cd_fixture-1:yes'))
    assert.equal(yes.pricePaise, 610, 'the traded price is never rewritten')
  })

  test('a provider failure is reported and leaves existing markets alone', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    stubCricket(success([fixture()]))
    await syncProviderMarkets()

    globalThis.fetch = (() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }) as typeof fetch
    resetCricketCache()
    resetProviderMarketSync()
    const result = await syncProviderMarkets()

    assert.equal(result.inserted, 0)
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /^cricketdata: /)
    assert.equal((await db.select().from(markets)).length, 1, 'the market that already exists is untouched')
  })

  test('a rejected subscription writes nothing', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    // This provider reports a bad subscription on HTTP 200.
    stubCricket({ status: 'failure', reason: 'Subscription invalid' })

    const result = await syncProviderMarkets()

    assert.equal(result.inserted, 0)
    assert.deepEqual(result.failures, ['cricketdata: auth'])
    assert.equal((await db.select().from(markets)).length, 0)
  })

  test('finished matches are not listed as markets', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    stubCricket(success([fixture({ id: 'finished-1', matchEnded: true, matchStarted: true })]))

    const result = await syncProviderMarkets()

    assert.equal(result.inserted, 0)
    assert.equal((await db.select().from(markets)).length, 0)
  })

  test('repeated syncs of the same fixture never duplicate it', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    stubCricket(success([fixture()]))

    for (let round = 0; round < 3; round += 1) {
      resetProviderMarketSync()
      await syncProviderMarkets()
    }

    assert.equal((await db.select().from(markets)).length, 1)
    assert.equal((await db.select().from(marketOutcomes).where(eq(marketOutcomes.marketId, 'cd_fixture-1'))).length, 2)
  })
})
