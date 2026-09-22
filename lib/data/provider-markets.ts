import 'server-only'

import { inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { marketOutcomes, marketPriceHistory, markets } from '@/lib/db/schema'
import {
  cricketFixturesToDrafts,
  cricketProviderConfigured,
  fetchCricketFixtures,
} from '@/lib/providers/cricket'
import type { MarketDraft } from '@/lib/providers/drafts'
import { footballFixturesToDrafts, footballProviderConfigured, fetchFootballFixtures } from '@/lib/providers/football'

/**
 * Live fixtures, written into the catalogue alongside the seeded demo markets.
 *
 * **Alongside, not instead of.** A provider key is optional, a free plan lists
 * only the next few fixtures, and a freshly connected key would otherwise leave
 * the market list nearly empty — so the demo catalogue stays as the floor and
 * live fixtures are added on top. Nothing here removes or replaces a market.
 *
 * Refreshes are deliberately narrow. A fixture feed knows about the *fixture*:
 * its teams, its league, when it starts, whether it is in play. It does not know
 * this application's prices, volume, trader count, liquidity or status, and
 * several of those are money-visible. So a refresh updates descriptive fields
 * and the close time, and never touches a price, a volume, a liquidity figure or
 * a status a human may have paused or resolved. Outcome prices are only ever
 * written when the market row is created.
 *
 * Nothing is deleted. A fixture that has finished stays in the catalogue for an
 * admin to settle — resolving markets from live scores is a deliberately
 * separate, larger change.
 */

/** How long a sync result is reused before asking the providers again. */
const SYNC_TTL_MS = 10 * 60_000

export interface ProviderSyncResult {
  inserted: number
  updated: number
  /** True when no provider is configured, so no provider was called. */
  skipped: boolean
  /** Per-provider failures, as `provider: kind` — never a credential or a body. */
  failures: string[]
}

let lastSync: { at: number; result: ProviderSyncResult } | null = null
let inFlight: Promise<ProviderSyncResult> | null = null

export function providerMarketsEnabled(): boolean {
  return cricketProviderConfigured() || footballProviderConfigured()
}

/** Names of the providers this deployment can currently read. */
export function configuredProviders(): string[] {
  const providers: string[] = []
  if (cricketProviderConfigured()) providers.push('cricketdata')
  if (footballProviderConfigured()) providers.push('api-football')
  return providers
}

/**
 * One refresh per TTL window per process, shared by concurrent callers.
 *
 * In-process state again: with several instances each one syncs on its own
 * schedule. That is acceptable here because the operation is idempotent and the
 * provider calls are cached per adapter, but it is the same note as
 * `lib/providers/cache.ts` — a shared cache is the right answer once more than
 * one instance is serving traffic.
 */
export async function syncProviderMarkets(): Promise<ProviderSyncResult> {
  if (!providerMarketsEnabled()) {
    return { inserted: 0, updated: 0, skipped: true, failures: [] }
  }
  if (lastSync && Date.now() - lastSync.at < SYNC_TTL_MS) return lastSync.result
  if (inFlight) return inFlight

  inFlight = runSync()
    .then((result) => {
      lastSync = { at: Date.now(), result }
      return result
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Test and smoke-script affordance: forget the memoized result. */
export function resetProviderMarketSync() {
  lastSync = null
}

async function runSync(): Promise<ProviderSyncResult> {
  const failures: string[] = []
  const drafts: MarketDraft[] = []

  if (cricketProviderConfigured()) {
    try {
      drafts.push(...cricketFixturesToDrafts(await fetchCricketFixtures()))
    } catch (error) {
      failures.push(`cricketdata: ${failureLabel(error)}`)
    }
  }
  if (footballProviderConfigured()) {
    try {
      drafts.push(...footballFixturesToDrafts(await fetchFootballFixtures()))
    } catch (error) {
      failures.push(`api-football: ${failureLabel(error)}`)
    }
  }

  if (failures.length > 0) {
    // Loud enough to find in the deploy logs, quiet enough not to fail a page.
    console.error(`[data] provider markets unavailable (${failures.join('; ')})`)
  }
  if (drafts.length === 0) {
    return { inserted: 0, updated: 0, skipped: false, failures }
  }

  const existing = new Set(
    (
      await db
        .select({ id: markets.id })
        .from(markets)
        .where(inArray(markets.id, drafts.map((draft) => draft.id)))
    ).map((row) => row.id),
  )

  const now = Date.now()
  await db.transaction(async (tx) => {
    for (const draft of drafts) {
      await tx
        .insert(markets)
        .values({
          id: draft.id,
          slug: draft.slug,
          question: draft.question,
          headline: draft.headline,
          description: draft.description,
          resolutionCriteria: draft.resolutionCriteria,
          source: draft.source,
          categoryId: draft.categoryId,
          kind: draft.kind,
          status: 'open',
          league: draft.league ?? null,
          emblem: draft.emblem,
          live: draft.live,
          featured: draft.featured,
          bonus: draft.bonus,
          createdAt: now,
          opensAt: draft.opensAt,
          closesAt: draft.closesAt,
          resolvesAt: draft.resolvesAt,
          volumePaise: 0,
          liquidityPaise: draft.liquidityPaise,
          traders: 0,
        })
        .onConflictDoUpdate({
          target: markets.id,
          // Descriptive fields only: the fixture may have been rescheduled,
          // renamed or started, but it never has an opinion about this
          // application's prices, volume, liquidity or status.
          set: {
            question: draft.question,
            headline: draft.headline,
            description: draft.description,
            resolutionCriteria: draft.resolutionCriteria,
            source: draft.source,
            league: draft.league ?? null,
            emblem: draft.emblem,
            live: draft.live,
            closesAt: draft.closesAt,
            resolvesAt: draft.resolvesAt,
          },
        })

      // Prices are written only for a market that does not exist yet. On a
      // refresh these inserts are no-ops, so a traded price is never reset.
      await tx
        .insert(marketOutcomes)
        .values(
          draft.outcomes.map((outcome) => ({
            id: outcome.id,
            marketId: draft.id,
            name: outcome.name,
            side: outcome.side,
            pricePaise: outcome.pricePaise,
            previousPricePaise: outcome.pricePaise,
          })),
        )
        .onConflictDoNothing()

      await tx
        .insert(marketPriceHistory)
        .values({
          id: `${draft.id}:${draft.opensAt}`,
          marketId: draft.id,
          t: draft.opensAt,
          yesPricePaise: draft.outcomes[0].pricePaise,
        })
        .onConflictDoNothing()
    }
  })

  const result = {
    inserted: drafts.filter((draft) => !existing.has(draft.id)).length,
    updated: drafts.filter((draft) => existing.has(draft.id)).length,
    skipped: false,
    failures,
  }
  if (result.inserted > 0 || result.updated > 0) {
    console.info(`[data] provider markets synced: ${result.inserted} new, ${result.updated} refreshed`)
  }
  return result
}

/** `CricketDataError` names its own failure kind; anything else keeps its name. */
function failureLabel(error: unknown): string {
  if (error instanceof Error) {
    const kind = (error as { kind?: unknown }).kind
    return typeof kind === 'string' ? kind : error.name
  }
  return 'unknown failure'
}
