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
 * API-Football (api-football.com / api-sports.io) — upcoming football fixtures.
 *
 * Confirmed against the live service from this repository:
 *  - host `https://v3.football.api-sports.io`
 *  - a request without a credential is refused with **HTTP 403**, so 403 has to
 *    be treated as an authentication failure here
 *
 * Taken from the vendor's documented contract (their documentation site refuses
 * this repository's fetches with 403, so these could not be re-read here — a key
 * was also unavailable to this shell, so no authenticated call was made):
 *  - the credential travels in the **`x-apisports-key` header**
 *  - `GET /fixtures?next=N` returns the next N fixtures, which avoids guessing
 *    the caller's calendar day
 *  - failures can also arrive as **HTTP 200 with a populated `errors` object**
 *    (`{"errors":{"token":"..."}}`, `{"errors":{"plan":"..."}}`), so the body is
 *    checked as well as the status
 *
 * Rate limits: the plan dashboard advertises a daily request allowance (100/day
 * on the free tier) plus a per-minute cap. A 30-minute TTL keeps a continuously
 * busy deployment at 48 upstream calls per day, comfortably inside that, and the
 * cache's single-flight behaviour means a traffic burst produces one call rather
 * than one per visitor.
 *
 * Free-tier plans restrict which seasons are readable; a plan refusal is
 * classified as `plan-restricted` so the logs say "upgrade the plan" rather than
 * "the provider is down".
 */

const BASE_URL = 'https://v3.football.api-sports.io'
const TIMEOUT_MS = 5_000
const TTL_MS = 30 * 60_000

/** How many fixtures to pull per refresh. `/fixtures?next=` accepts a small page. */
const FIXTURE_WINDOW = 20
/** A fixture becomes a market this far ahead of kick-off. */
const MARKET_HORIZON_MS = 14 * 86_400_000

/** Statuses that mean the match is over and only a human can resolve it. */
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'ABD', 'AWD', 'WO', 'CANC', 'PST', 'SUSP', 'INT'])

export type FootballFailureKind =
  | 'not-configured'
  | 'auth'
  | 'rate-limit'
  | 'plan-restricted'
  | 'timeout'
  | 'network'
  | 'malformed'
  | 'unavailable'

export class FootballDataError extends Error {
  readonly kind: FootballFailureKind
  readonly status?: number

  constructor(kind: FootballFailureKind, detail: string, status?: number) {
    super(`api-football ${kind}: ${detail}`)
    this.name = 'FootballDataError'
    this.kind = kind
    this.status = status
  }
}

export interface FootballFixture {
  id: string
  home: string
  away: string
  homeShort: string
  awayShort: string
  league: string
  country?: string
  round?: string
  venue?: string
  startsAt: number
  statusShort?: string
  live: boolean
  finished: boolean
}

/** Raw shapes, kept local to this adapter. */
interface ApiFootballFixtureEntry {
  fixture?: {
    id?: number | string
    date?: string
    timestamp?: number
    venue?: { name?: string; city?: string }
    status?: { long?: string; short?: string; elapsed?: number | null }
  }
  league?: { name?: string; country?: string; round?: string }
  teams?: { home?: { name?: string }; away?: { name?: string } }
}

interface ApiFootballResponse {
  errors?: unknown
  results?: number
  response?: ApiFootballFixtureEntry[]
}

const fixturesCache = createTtlCache<FootballFixture[]>({ name: 'api-football', ttlMs: TTL_MS })

export function footballProviderConfigured(): boolean {
  return Boolean(process.env.API_FOOTBALL_KEY?.trim())
}

/**
 * Forgets the cached fixture list, so the next read goes upstream. Mirrors
 * `resetCricketCache`; used by the smoke script and the test suite.
 */
export function resetFootballCache(): void {
  fixturesCache.clear()
}

/** Upcoming fixtures. Throws `FootballDataError`; callers fall back to demo data. */
export async function fetchFootballFixtures(options: { refresh?: boolean } = {}): Promise<FootballFixture[]> {
  const key = process.env.API_FOOTBALL_KEY?.trim()
  if (!key) throw new FootballDataError('not-configured', 'API_FOOTBALL_KEY is not set')

  if (options.refresh) fixturesCache.clear()

  return fixturesCache.getOrLoad('next-fixtures', async () => {
    const url = `${BASE_URL}/fixtures?next=${FIXTURE_WINDOW}`

    let payload: ApiFootballResponse
    try {
      payload = await getJson<ApiFootballResponse>({
        provider: 'api-football',
        url,
        headers: { 'x-apisports-key': key },
        timeoutMs: TIMEOUT_MS,
      })
    } catch (error) {
      throw toFootballError(error)
    }

    // The provider also reports refusals inside a 200 response.
    const bodyFailure = classifyBodyErrors(payload.errors)
    if (bodyFailure) {
      console.error(`[providers] api-football ${bodyFailure.kind}: ${bodyFailure.message}`)
      throw bodyFailure
    }

    const fixtures = (payload.response ?? [])
      .map(normaliseFixture)
      .filter((fixture): fixture is FootballFixture => fixture !== null)

    console.info(`[providers] api-football ${fixtures.length} fixture(s) from ${FIXTURE_WINDOW} requested`)
    return fixtures
  })
}

/** Maps fixtures into this app's market shape. Pure: no network, no clock beyond `now`. */
export function footballFixturesToDrafts(fixtures: FootballFixture[], now = Date.now()): MarketDraft[] {
  return fixtures
    .filter((fixture) => !fixture.finished)
    .filter((fixture) => fixture.startsAt <= now + MARKET_HORIZON_MS)
    .map((fixture) => {
      const { id, slug } = providerMarketIds('af', fixture.id)
      const league = [fixture.league, fixture.country].filter(Boolean).join(' · ')
      const venue = [fixture.venue, fixture.country].filter(Boolean).join(', ')

      return {
        id,
        slug,
        question: `Will ${fixture.home} beat ${fixture.away}?`,
        headline: `${fixture.homeShort} vs ${fixture.awayShort}`,
        description:
          `${league}${fixture.round ? ` · ${fixture.round}` : ''}. ` +
          `${fixture.home} vs ${fixture.away}${venue ? ` at ${venue}` : ''}. ` +
          'The market closes at kick-off and settles on the result declared by the officials, including extra time and penalties.',
        resolutionCriteria:
          `Resolves to ${fixture.homeShort} if ${fixture.home} are declared the winner, otherwise ${fixture.awayShort}. ` +
          'A postponed or abandoned match refunds every trade in full.',
        source: 'Official match result (API-Football)',
        categoryId: 'football',
        kind: 'match',
        league: fixture.league,
        emblem: fixture.homeShort.slice(0, 4).toUpperCase(),
        live: fixture.live,
        featured: false,
        bonus: false,
        opensAt: now,
        closesAt: fixture.startsAt,
        resolvesAt: fixture.startsAt + 3 * 60 * 60_000,
        liquidityPaise: providerLiquidityPaise(),
        outcomes: [
          { id: `${id}:yes`, name: fixture.homeShort, side: 'yes', pricePaise: EVEN_PRICE_PAISE },
          { id: `${id}:no`, name: fixture.awayShort, side: 'no', pricePaise: 1000 - EVEN_PRICE_PAISE },
        ],
      }
    })
}

function normaliseFixture(entry: ApiFootballFixtureEntry): FootballFixture | null {
  const home = entry.teams?.home?.name?.trim()
  const away = entry.teams?.away?.name?.trim()
  const externalId = entry.fixture?.id
  if (!home || !away || externalId === undefined || externalId === null) return null

  const startsAt = entry.fixture?.timestamp ? entry.fixture.timestamp * 1000 : Date.parse(entry.fixture?.date ?? '')
  if (!Number.isFinite(startsAt)) return null

  const statusShort = entry.fixture?.status?.short?.trim().toUpperCase()
  const elapsed = entry.fixture?.status?.elapsed
  const finished = statusShort ? FINISHED_STATUSES.has(statusShort) : false
  // 1H/2H/HT/ET/P/LIVE are the in-play statuses this provider uses.
  const live = !finished && (statusShort === '1H' || statusShort === '2H' || statusShort === 'HT' || statusShort === 'ET' || statusShort === 'P' || statusShort === 'LIVE' || (typeof elapsed === 'number' && elapsed > 0))

  return {
    id: String(externalId),
    home,
    away,
    homeShort: shortLabel(home),
    awayShort: shortLabel(away),
    league: entry.league?.name?.trim() || 'Football',
    country: entry.league?.country?.trim() || undefined,
    round: entry.league?.round?.trim() || undefined,
    venue: [entry.fixture?.venue?.name?.trim(), entry.fixture?.venue?.city?.trim()].filter(Boolean).join(', ') || undefined,
    startsAt,
    statusShort,
    live,
    finished,
  }
}

/**
 * A short label for an outcome button, derived here rather than supplied by the
 * provider: it only returns full club names. Three-letter form for a single-word
 * club (Arsenal → ARS), initials for a multi-word one (Manchester City → MC).
 */
function shortLabel(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return name.slice(0, 3).toUpperCase()
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words.slice(0, 3).map((word) => word[0]).join('').toUpperCase()
}

function toFootballError(error: unknown): FootballDataError {
  if (error instanceof FootballDataError) return error
  if (error instanceof ProviderRequestError) {
    const kind: FootballFailureKind =
      error.kind === 'auth' ? 'auth'
        : error.kind === 'rate-limit' ? 'rate-limit'
          : error.kind === 'timeout' ? 'timeout'
            : error.kind === 'malformed' ? 'malformed'
              : 'network'
    return new FootballDataError(kind, error.message, error.status)
  }
  return new FootballDataError('unavailable', error instanceof Error ? error.message : 'unknown failure')
}

/**
 * Reads the provider's in-body errors. The field is an empty array when there is
 * nothing wrong, and an object of `{ field: message }` when there is.
 */
function classifyBodyErrors(errors: unknown): FootballDataError | null {
  const messages = collectMessages(errors)
  if (messages.length === 0) return null

  const text = messages.join('; ')
  const lowered = text.toLowerCase()
  if (lowered.includes('token') || lowered.includes('key') || lowered.includes('not subscribed') || lowered.includes('unauthorized')) {
    return new FootballDataError('auth', text)
  }
  if (lowered.includes('rate') || lowered.includes('limit') || lowered.includes('request')) {
    return new FootballDataError('rate-limit', text)
  }
  if (lowered.includes('plan') || lowered.includes('season') || lowered.includes('subscription') || lowered.includes('upgrade')) {
    return new FootballDataError('plan-restricted', text)
  }
  return new FootballDataError('unavailable', text)
}

function collectMessages(value: unknown): string[] {
  if (!value) return []
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (Array.isArray(value)) return value.flatMap(collectMessages)
  if (typeof value === 'object') {
    // The field name is the classification signal — this provider reports
    // `{"errors":{"token":"Error/Missing application key"}}` and the value alone
    // does not say that the credential is what failed.
    return Object.entries(value as Record<string, unknown>).flatMap(([field, nested]) => {
      const messages = collectMessages(nested)
      return messages.map((message) => `${field}: ${message}`)
    })
  }
  return []
}
