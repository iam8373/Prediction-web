import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { FootballDataError, fetchFootballFixtures, footballFixturesToDrafts } from '@/lib/providers/football'

const realFetch = globalThis.fetch
const KEY = 'test-football-key-9876'

let lastRequest: { url: string; init?: RequestInit } | null = null

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    lastRequest = { url: String(input), init }
    return Promise.resolve(handler(String(input), init))
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function failureFrom(run: () => Promise<unknown>): Promise<FootballDataError> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof FootballDataError, `expected a FootballDataError, received ${String(error)}`)
    return error
  }
  throw new Error('expected the call to fail')
}

afterEach(() => {
  globalThis.fetch = realFetch
  lastRequest = null
  delete process.env.API_FOOTBALL_KEY
})

const FIXTURE = {
  fixture: {
    id: 1181175,
    date: '2026-09-25T14:00:00+00:00',
    timestamp: Math.floor(Date.UTC(2026, 8, 25, 14, 0) / 1000),
    venue: { name: 'Emirates Stadium', city: 'London' },
    status: { long: 'Not Started', short: 'NS', elapsed: null },
  },
  league: { name: 'Premier League', country: 'England', round: 'Regular Season - 6' },
  teams: { home: { name: 'Arsenal' }, away: { name: 'Manchester City' } },
  goals: { home: null, away: null },
}

describe('API-Football adapter', () => {
  test('the credential is sent as a header, never in the URL', async () => {
    process.env.API_FOOTBALL_KEY = KEY
    stubFetch(() => jsonResponse({ errors: [], results: 1, response: [FIXTURE] }))

    await fetchFootballFixtures({ refresh: true })

    const headers = (lastRequest?.init?.headers ?? {}) as Record<string, string>
    assert.equal(headers['x-apisports-key'], KEY)
    assert.ok(!(lastRequest?.url ?? '').includes(KEY), 'the key must not be in the query string')
  })

  test('a 403 without a valid credential is an auth failure', async () => {
    process.env.API_FOOTBALL_KEY = KEY
    stubFetch(() => new Response('Forbidden', { status: 403 }))

    const error = await failureFrom(() => fetchFootballFixtures({ refresh: true }))
    assert.equal(error.kind, 'auth')
  })

  test('an in-body token error on a 200 is an auth failure', async () => {
    process.env.API_FOOTBALL_KEY = KEY
    stubFetch(() => jsonResponse({ errors: { token: 'Error/Missing application key' }, results: 0, response: [] }))

    const error = await failureFrom(() => fetchFootballFixtures({ refresh: true }))
    assert.equal(error.kind, 'auth')
  })

  test('a plan refusal is reported as such, not as an outage', async () => {
    process.env.API_FOOTBALL_KEY = KEY
    stubFetch(() => jsonResponse({ errors: { plan: 'Free plan does not allow access to this season, upgrade your plan' }, results: 0, response: [] }))

    const error = await failureFrom(() => fetchFootballFixtures({ refresh: true }))
    assert.equal(error.kind, 'plan-restricted')
  })

  test('a missing key fails without making any request', async () => {
    stubFetch(() => jsonResponse({ errors: [], response: [] }))

    const error = await failureFrom(() => fetchFootballFixtures({ refresh: true }))
    assert.equal(error.kind, 'not-configured')
    assert.equal(lastRequest, null)
  })

  test('the credential never appears in an error message or a log line', async () => {
    process.env.API_FOOTBALL_KEY = KEY
    const logged: string[] = []
    const realError = console.error
    const realInfo = console.info
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    console.info = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }

    try {
      stubFetch(() => jsonResponse({ errors: { token: 'invalid' }, response: [] }))
      const error = await failureFrom(() => fetchFootballFixtures({ refresh: true }))
      for (const text of [error.message, ...logged]) {
        assert.ok(!text.includes(KEY), `the credential leaked into: ${text}`)
      }
    } finally {
      console.error = realError
      console.info = realInfo
    }
  })
})

describe('API-Football market mapping', () => {
  const now = Date.UTC(2026, 8, 22, 6, 0)

  test('a fixture becomes a match market on the football category', () => {
    const drafts = footballFixturesToDrafts([{
      id: '1181175',
      home: 'Arsenal',
      away: 'Manchester City',
      homeShort: 'ARS',
      awayShort: 'MC',
      league: 'Premier League',
      country: 'England',
      round: 'Regular Season - 6',
      venue: 'Emirates Stadium, London',
      startsAt: now + 86_400_000,
      statusShort: 'NS',
      live: false,
      finished: false,
    }], now)

    const [draft] = drafts
    assert.equal(draft.categoryId, 'football')
    assert.equal(draft.kind, 'match')
    assert.equal(draft.question, 'Will Arsenal beat Manchester City?')
    assert.equal(draft.headline, 'ARS vs MC')
    assert.equal(draft.league, 'Premier League')
    assert.match(draft.description, /Premier League · England/)
    assert.match(draft.description, /Emirates Stadium, London/)
    assert.equal(draft.outcomes[0].pricePaise, 500)
    assert.equal(draft.id, 'af_1181175')
  })

  test('finished fixtures do not become markets', () => {
    const base = {
      home: 'Arsenal', away: 'Chelsea', homeShort: 'ARS', awayShort: 'CHE',
      league: 'Premier League', startsAt: now - 3_600_000, live: false,
    }
    const drafts = footballFixturesToDrafts([
      { ...base, id: '1', finished: true },
      { ...base, id: '2', startsAt: now + 3_600_000, finished: false },
    ], now)

    assert.deepEqual(drafts.map((draft) => draft.id), ['af_2'])
  })

  test('a live fixture is flagged live and still closes at kick-off', () => {
    const startsAt = now - 30 * 60_000
    const [draft] = footballFixturesToDrafts([{
      id: '99', home: 'Arsenal', away: 'Chelsea', homeShort: 'ARS', awayShort: 'CHE',
      league: 'Premier League', startsAt, live: true, finished: false,
    }], now)

    assert.equal(draft.live, true)
    assert.equal(draft.closesAt, startsAt)
  })
})
