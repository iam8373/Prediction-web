import 'server-only'

import { createTtlCache } from '@/lib/providers/cache'
import {
  EVEN_PRICE_PAISE,
  providerLiquidityPaise,
  providerMarketIds,
  type MarketDraft,
} from '@/lib/providers/drafts'
import { getJson, ProviderRequestError } from '@/lib/providers/http'

/**
 * CricketData (cricketdata.org, "CricAPI") — upcoming and live cricket matches.
 *
 * Confirmed against the live service from this repository:
 *  - base URL `https://api.cricapi.com/v1`, endpoint `currentMatches`
 *  - the key travels as the `apikey` **query parameter** (not a header)
 *  - the API answers **HTTP 200 with `{"status":"failure","reason":"..."}`** for a
 *    rejected key, so `response.ok` is not an authentication signal here. The
 *    subscription state is read from `status`/`reason` instead.
 *  - the response **echoes the submitted key** in a top-level `apikey` field, so
 *    response bodies from this provider are never logged, in whole or in part.
 *
 * Not confirmed from this environment (no key was available to this shell):
 * the exact per-plan daily hit allowance. The response carries
 * `info.hitsToday` / `info.hitsLimit`, which this adapter logs so the real
 * allowance is visible in the deployment logs rather than assumed.
 *
 * Rate limits: this is a daily-hit-limited API, so the TTL below is chosen for
 * the whole day rather than for a burst — 30 minutes caps a continuously busy
 * deployment at 48 upstream calls per day, and the cache is only filled when a
 * page actually asks for fixtures.
 */

const BASE_URL = 'https://api.cricapi.com/v1'
const TIMEOUT_MS = 5_000
const TTL_MS = 30 * 60_000

/** How far ahead a fixture becomes a market, and how long after the start it stays one. */
const MARKET_HORIZON_MS = 14 * 86_400_000
const LIVE_GRACE_MS = 6 * 60 * 60_000

export type CricketFailureKind =
  | 'not-configured'
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'malformed'
  | 'unavailable'

export class CricketDataError extends Error {
  readonly kind: CricketFailureKind
  readonly status?: number

  constructor(kind: CricketFailureKind, detail: string, status?: number) {
    super(`cricketdata ${kind}: ${detail}`)
    this.name = 'CricketDataError'
    this.kind = kind
    this.status = status
  }
}

export interface CricketFixture {
  id: string
  name: string
  series?: string
  matchType?: string
  venue?: string
  teams: [string, string]
  teamsShort: [string, string]
  startsAt: number
  status?: string
  live: boolean
  ended: boolean
}

/** Raw shapes, kept local to this adapter so no other module depends on them. */
interface CricApiMatch {
  id?: string
  name?: string
  matchType?: string
  status?: string
  venue?: string
  date?: string
  dateTimeGMT?: string
  teams?: string[]
  teamInfo?: Array<{ name?: string; shortname?: string }>
  series?: string
  matchStarted?: boolean
  matchEnded?: boolean
}

interface CricApiResponse {
  status?: string
  reason?: string
  data?: CricApiMatch[]
  info?: { hitsToday?: number; hitsLimit?: number }
}

const fixturesCache = createTtlCache<CricketFixture[]>({ name: 'cricketdata', ttlMs: TTL_MS })

export function cricketProviderConfigured(): boolean {
  return Boolean(process.env.CRICKETDATA_API_KEY?.trim())
}

/**
 * Upcoming and live matches. Throws `CricketDataError`; callers decide whether
 * that means "fall back to the demo catalogue" (it does) or "tell an operator".
 */
export async function fetchCricketFixtures(options: { refresh?: boolean } = {}): Promise<CricketFixture[]> {
  const key = process.env.CRICKETDATA_API_KEY?.trim()
  if (!key) throw new CricketDataError('not-configured', 'CRICKETDATA_API_KEY is not set')

  if (options.refresh) fixturesCache.clear()

  return fixturesCache.getOrLoad('currentMatches', async () => {
    const url = `${BASE_URL}/currentMatches?apikey=${encodeURIComponent(key)}&offset=0`

    let payload: CricApiResponse
    try {
      payload = await getJson<CricApiResponse>({ provider: 'cricketdata', url, timeoutMs: TIMEOUT_MS })
    } catch (error) {
      throw toCricketError(error)
    }

    // 200 does not mean success: read the subscription status out of the body.
    if (payload.status !== 'success') {
      const failure = classifySubscriptionFailure(payload.reason)
      logFailure(failure, payload.reason)
      throw failure
    }

    const fixtures = (payload.data ?? []).map(normaliseFixture).filter((fixture): fixture is CricketFixture => fixture !== null)

    // The plan's real allowance, straight from the provider, so a deployment can
    // see how close it is to the daily cap without guessing.
    if (payload.info) {
      console.info(
        `[providers] cricketdata hits today ${payload.info.hitsToday ?? '?'}/${payload.info.hitsLimit ?? '?'} · ${fixtures.length} fixture(s)`,
      )
    }

    return fixtures
  })
}

/** Maps fixtures into this app's market shape. Pure: no network, no clock beyond `now`. */
export function cricketFixturesToDrafts(fixtures: CricketFixture[], now = Date.now()): MarketDraft[] {
  return fixtures
    .filter((fixture) => !fixture.ended)
    .filter((fixture) => fixture.startsAt <= now + MARKET_HORIZON_MS && fixture.startsAt >= now - LIVE_GRACE_MS)
    .map((fixture) => {
      const [home, away] = fixture.teams
      const [homeShort, awayShort] = fixture.teamsShort
      const { id, slug } = providerMarketIds('cd', fixture.id)
      const league = fixture.series?.trim() || fixture.matchType?.toUpperCase() || 'Cricket'
      const format = fixture.matchType ? fixture.matchType.toUpperCase() : 'match'

      return {
        id,
        slug,
        question: `Will ${home} beat ${away} in the ${format}?`,
        headline: `${homeShort} vs ${awayShort}`,
        description:
          `${league}. ${home} vs ${away}` +
          `${fixture.venue ? ` at ${fixture.venue}` : ''}. ` +
          'The market closes when the match starts and settles on the result declared by the match officials.',
        resolutionCriteria:
          `Resolves to ${homeShort} if ${home} are declared the winner by the match officials, ` +
          `otherwise ${awayShort}. A no-result or abandoned match refunds every trade in full.`,
        source: 'Official match result (CricketData)',
        categoryId: 'cricket',
        kind: 'match',
        league,
        emblem: (homeShort || format).slice(0, 4).toUpperCase(),
        live: fixture.live,
        featured: false,
        bonus: false,
        // A fixture market opens as soon as it is listed and closes at the toss.
        opensAt: now,
        closesAt: fixture.startsAt,
        // Settlement is a human action today, so this is a reminder timestamp,
        // not the moment money is expected to move.
        resolvesAt: fixture.startsAt + 4 * 60 * 60_000,
        liquidityPaise: providerLiquidityPaise(),
        outcomes: [
          { id: `${id}:yes`, name: homeShort || home, side: 'yes', pricePaise: EVEN_PRICE_PAISE },
          { id: `${id}:no`, name: awayShort || away, side: 'no', pricePaise: 1000 - EVEN_PRICE_PAISE },
        ],
      }
    })
}

function normaliseFixture(match: CricApiMatch): CricketFixture | null {
  const teams = (match.teams ?? []).filter((team): team is string => typeof team === 'string' && team.trim().length > 0)
  if (!match.id || teams.length < 2) return null

  const startsAt = parseStart(match.dateTimeGMT ?? match.date)
  if (startsAt === null) return null

  const shortFor = (index: number) => {
    const info = match.teamInfo?.[index]
    const short = info?.shortname?.trim()
    return short && short.length > 0 ? short : teams[index]
  }

  return {
    id: String(match.id),
    name: match.name?.trim() || `${teams[0]} vs ${teams[1]}`,
    series: match.series?.trim() || undefined,
    matchType: match.matchType?.trim() || undefined,
    venue: match.venue?.trim() || undefined,
    teams: [teams[0], teams[1]],
    teamsShort: [shortFor(0), shortFor(1)],
    startsAt,
    status: match.status?.trim() || undefined,
    live: match.matchStarted === true && match.matchEnded !== true,
    ended: match.matchEnded === true,
  }
}

function parseStart(value?: string): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toCricketError(error: unknown): CricketDataError {
  if (error instanceof CricketDataError) return error
  if (error instanceof ProviderRequestError) {
    // A rejected key on this provider usually arrives as a 200 with a
    // subscription reason; a genuine 401/403/429 is still mapped by kind.
    const kind: CricketFailureKind =
      error.kind === 'auth' ? 'auth'
        : error.kind === 'rate-limit' ? 'rate-limit'
          : error.kind === 'timeout' ? 'timeout'
            : error.kind === 'malformed' ? 'malformed'
              : 'network'
    return new CricketDataError(kind, error.message, error.status)
  }
  return new CricketDataError('unavailable', error instanceof Error ? error.message : 'unknown failure')
}

function classifySubscriptionFailure(reason?: string): CricketDataError {
  const text = (reason ?? 'the provider did not report success').trim()
  const lowered = text.toLowerCase()
  if (lowered.includes('subscription') || lowered.includes('invalid') || lowered.includes('apikey') || lowered.includes('api key')) {
    return new CricketDataError('auth', text)
  }
  if (lowered.includes('limit') || lowered.includes('quota') || lowered.includes('exceed') || lowered.includes('hit')) {
    return new CricketDataError('rate-limit', text)
  }
  return new CricketDataError('unavailable', text)
}

/**
 * Logs which failure occurred and nothing else. The provider's `reason` string
 * is safe (it is about the subscription); the response body is not, because it
 * contains the submitted key.
 */
function logFailure(error: CricketDataError, reason?: string) {
  console.error(`[providers] cricketdata ${error.kind}: ${reason ?? error.message}`)
}
