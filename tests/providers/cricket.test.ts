import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { CricketDataError, cricketFixturesToDrafts, fetchCricketFixtures } from '@/lib/providers/cricket'

/**
 * These run with a stubbed `fetch`: the adapter's contract is what is under
 * test, not the provider's uptime. A live call would also bill the operator's
 * daily hit allowance on every test run.
 */

const realFetch = globalThis.fetch
const KEY = 'test-cricket-key-1234'

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: unknown, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function failureFrom(run: () => Promise<unknown>): Promise<CricketDataError> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof CricketDataError, `expected a CricketDataError, received ${String(error)}`)
    return error
  }
  throw new Error('expected the call to fail')
}

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.CRICKETDATA_API_KEY
})

const FIXTURE = {
  id: 'a1b2c3',
  name: 'New Delhi Tigers vs West Delhi Lions',
  matchType: 't20',
  status: 'Match not started',
  venue: 'Arun Jaitley Stadium',
  dateTimeGMT: '2026-09-25T14:00:00',
  teams: ['New Delhi Tigers', 'West Delhi Lions'],
  teamInfo: [
    { name: 'New Delhi Tigers', shortname: 'NDT' },
    { name: 'West Delhi Lions', shortname: 'WDL' },
  ],
  series: 'T20 - DPL',
  matchStarted: false,
  matchEnded: false,
}

describe('CricketData adapter', () => {
  test('a rejected subscription arrives as HTTP 200 and is reported as an auth failure', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    stubFetch(() => jsonResponse({ apikey: KEY, status: 'failure', reason: 'Subscription invalid' }))

    const error = await failureFrom(() => fetchCricketFixtures({ refresh: true }))
    assert.equal(error.kind, 'auth')
  })

  test('a missing key fails without making any request', async () => {
    let called = false
    stubFetch(() => {
      called = true
      return jsonResponse({})
    })

    const error = await failureFrom(() => fetchCricketFixtures({ refresh: true }))
    assert.equal(error.kind, 'not-configured')
    assert.equal(called, false, 'no request is made without a credential')
  })

  test('a slow provider is abandoned, not waited on', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    stubFetch(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })

    const error = await failureFrom(() => fetchCricketFixtures({ refresh: true }))
    assert.equal(error.kind, 'timeout')
  })

  test('a 429 is reported as rate limiting, not as a bad key', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    stubFetch(() => jsonResponse({ status: 'failure' }, 429))

    const error = await failureFrom(() => fetchCricketFixtures({ refresh: true }))
    assert.equal(error.kind, 'rate-limit')
  })

  test('the credential never appears in an error message or a log line', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    const logged: string[] = []
    const realError = console.error
    const realInfo = console.info
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    console.info = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }

    try {
      // The provider echoes the key back in its body, so this response body is
      // the worst case: a failure path that logs the payload.
      stubFetch(() => jsonResponse({ apikey: KEY, status: 'failure', reason: 'Subscription invalid' }))
      const error = await failureFrom(() => fetchCricketFixtures({ refresh: true }))

      // A network-level failure, whose message carries the full request URL.
      stubFetch(() => {
        throw Object.assign(new Error(`connect ECONNREFUSED ${KEY}`), { name: 'FetchError' })
      })
      const networkError = await failureFrom(() => fetchCricketFixtures({ refresh: true }))

      for (const text of [error.message, networkError.message, ...logged]) {
        assert.ok(!text.includes(KEY), `the credential leaked into: ${text}`)
      }
      assert.ok(networkError.message.includes('REDACTED') || !networkError.message.includes('apikey'), 'the request URL is redacted')
    } finally {
      console.error = realError
      console.info = realInfo
    }
  })

  test('concurrent callers share one upstream request', async () => {
    process.env.CRICKETDATA_API_KEY = KEY
    let calls = 0
    stubFetch(() => {
      calls += 1
      return jsonResponse({ status: 'success', data: [FIXTURE] })
    })

    const [first, second, third] = await Promise.all([
      fetchCricketFixtures({ refresh: true }),
      fetchCricketFixtures(),
      fetchCricketFixtures(),
    ])

    assert.equal(calls, 1, 'three readers, one provider call')
    assert.equal(first.length, 1)
    assert.deepEqual(second, first)
    assert.deepEqual(third, first)
  })
})

describe('CricketData market mapping', () => {
  const now = Date.UTC(2026, 8, 22, 6, 0)

  test('a fixture becomes a match market on the cricket category', () => {
    const fixtures = [{
      id: 'a1b2c3',
      name: 'New Delhi Tigers vs West Delhi Lions',
      series: 'T20 - DPL',
      matchType: 't20',
      venue: 'Arun Jaitley Stadium',
      teams: ['New Delhi Tigers', 'West Delhi Lions'] as [string, string],
      teamsShort: ['NDT', 'WDL'] as [string, string],
      startsAt: now + 86_400_000,
      live: false,
      ended: false,
    }]

    const [draft] = cricketFixturesToDrafts(fixtures, now)
    assert.equal(draft.categoryId, 'cricket')
    assert.equal(draft.kind, 'match')
    assert.equal(draft.question, 'Will New Delhi Tigers beat West Delhi Lions in the T20?')
    assert.equal(draft.headline, 'NDT vs WDL')
    assert.equal(draft.league, 'T20 - DPL')
    assert.equal(draft.outcomes[0].name, 'NDT')
    assert.equal(draft.outcomes[0].side, 'yes')
    assert.equal(draft.outcomes[1].side, 'no')
    // An even market: a fixture feed carries no price information, and inventing
    // one would hand the first trader a made-up edge.
    assert.equal(draft.outcomes[0].pricePaise, 500)
    assert.equal(draft.outcomes[0].pricePaise + draft.outcomes[1].pricePaise, 1000)
    assert.equal(draft.outcomes[0].id, `${draft.id}:yes`)
    // Closes at the toss, and re-listable from the same fixture id after a refresh.
    assert.equal(draft.closesAt, fixtures[0].startsAt)
    assert.equal(draft.opensAt, now)
    assert.ok(draft.liquidityPaise > 0, 'a market needs depth to price against')
  })

  test('finished matches and far-future fixtures do not become markets', () => {
    const base = {
      name: 'A vs B',
      teams: ['A', 'B'] as [string, string],
      teamsShort: ['A', 'B'] as [string, string],
      live: false,
    }
    const drafts = cricketFixturesToDrafts([
      { ...base, id: 'done', startsAt: now - 86_400_000, ended: true },
      { ...base, id: 'soon', startsAt: now + 86_400_000, ended: false },
      { ...base, id: 'later', startsAt: now + 60 * 86_400_000, ended: false },
    ], now)

    assert.deepEqual(drafts.map((draft) => draft.id), ['cd_soon'])
  })

  test('ids are stable across refreshes, so a re-sync updates rather than duplicates', () => {
    const fixtureA = {
      id: 'Match/Id 42', name: 'A vs B', teams: ['A', 'B'] as [string, string],
      teamsShort: ['A', 'B'] as [string, string], startsAt: now + 3_600_000, live: false, ended: false,
    }
    const first = cricketFixturesToDrafts([fixtureA], now)[0]
    const second = cricketFixturesToDrafts([fixtureA], now + 60_000)[0]
    assert.equal(first.id, second.id)
    assert.equal(first.slug, second.slug)
    assert.match(first.id, /^cd_[a-z0-9-]+$/, 'the id is URL-safe')
  })
})
