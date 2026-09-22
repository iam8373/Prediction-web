import 'server-only'

/**
 * The shape every provider adapter maps into.
 *
 * This is an *output* contract, deliberately not a client: each adapter is
 * responsible for its own endpoint, credential, error type, caching and
 * parsing, and this only describes the value it hands to the data layer. That
 * keeps the mapping from "what the provider returned" to "what the app stores"
 * visible inside the adapter that knows the provider.
 */

export interface MarketDraftOutcome {
  id: string
  name: string
  side: 'yes' | 'no'
  pricePaise: number
}

export interface MarketDraft {
  /** Stable across refreshes, so a re-sync updates the same row instead of duplicating it. */
  id: string
  slug: string
  question: string
  headline: string
  description: string
  resolutionCriteria: string
  source: string
  categoryId: string
  kind: 'binary' | 'match'
  league?: string
  emblem: string
  live: boolean
  featured: boolean
  bonus: boolean
  opensAt: number
  closesAt: number
  resolvesAt: number
  liquidityPaise: number
  outcomes: [MarketDraftOutcome, MarketDraftOutcome]
}

/**
 * Opening liquidity for a provider-sourced market, in paise.
 *
 * A market created from a fixture has no trading history, so it needs a
 * starting depth for the pricing function to work against. The default is
 * ₹10,000; the demo catalogue derives its own liquidity from seeded volume,
 * which a live fixture does not have.
 */
export const DEFAULT_PROVIDER_LIQUIDITY_PAISE = 1_000_000

const MIN_LIQUIDITY_PAISE = 10_000
const MAX_LIQUIDITY_PAISE = 100_000_000

export function providerLiquidityPaise(): number {
  const configured = Number.parseInt(process.env.PROVIDER_MARKET_LIQUIDITY_PAISE ?? '', 10)
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_PROVIDER_LIQUIDITY_PAISE
  return Math.min(Math.max(configured, MIN_LIQUIDITY_PAISE), MAX_LIQUIDITY_PAISE)
}

/**
 * A market that opens even at 50/50. Nothing in a fixture feed says which side
 * the market thinks is more likely, and inventing a price would hand early
 * traders a fabricated edge.
 */
export const EVEN_PRICE_PAISE = 500

/** `cd_<provider id>` and a matching slug, so a fixture maps to one row forever. */
export function providerMarketIds(prefix: string, externalId: string) {
  const safe = externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return { id: `${prefix}_${safe}`, slug: `${prefix}-${safe}` }
}
