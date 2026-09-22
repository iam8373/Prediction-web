import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { AppShell } from '@/components/layout/app-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { PriceChart } from '@/components/charts/price-chart'
import { loadOrUnavailable } from '@/lib/db/availability'
import { MarketStatusHeader } from '@/components/markets/market-status-header'
import { MarketVideo } from '@/components/markets/market-video'
import { WatchlistButton } from '@/components/markets/watchlist-button'
import { TradePanel } from '@/components/trading/trade-panel'
import { Card, SectionHeading } from '@/components/ui/primitives'
import { getMarket, marketStats, recentTradesFromDb } from '@/lib/data/server-api'
import { fetchVideo } from '@/lib/providers/youtube'
import { formatINR, formatShares } from '@/lib/money'
import { priceToProbabilityBps } from '@/lib/trading/pricing'

export const dynamic = 'force-dynamic'

/**
 * The video a market is about, when it has one and the provider answers.
 *
 * This never throws and never blocks the page on a provider: an unconfigured
 * key, a deleted video and an outage all mean "no card". The adapter's own TTL
 * cache (six hours) is what keeps this from being an API call per visitor — the
 * page is dynamic, the metadata is not.
 */
async function loadMarketVideo(videoId?: string) {
  if (!videoId) return null
  try {
    return await fetchVideo(videoId)
  } catch (error) {
    console.info(`[market] video metadata unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const loaded = await loadOrUnavailable('market metadata', () => getMarket(id))
  // Metadata must never throw: an unreadable database is not a "not found".
  if (!loaded.ok) return { title: 'Market · Predik' }
  const market = loaded.value
  if (!market) return { title: 'Market not found · Predik' }
  return {
    title: `${market.question} · Predik`,
    description: market.description,
    openGraph: { title: market.question, description: market.description },
  }
}

export default async function MarketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ side?: string }>
}) {
  const { id } = await params
  const { side } = await searchParams

  // A database that cannot be read must produce a page, not an empty 500.
  const loaded = await loadOrUnavailable('market detail', async () => {
    const market = await getMarket(id)
    if (!market) return null
    const [trades, stats] = await Promise.all([
      recentTradesFromDb(market, 8),
      marketStats(market.id),
    ])
    return { market, trades, stats }
  })

  if (!loaded.ok) {
    return (
      <AppShell>
        <ServiceUnavailable reason={loaded.reason} />
      </AppShell>
    )
  }

  if (!loaded.value) notFound()
  const { market, trades, stats } = loaded.value
  const video = await loadMarketVideo(market.videoId)

  return (
    <AppShell>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <MarketStatusHeader market={market} stats={stats} />
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-xl leading-tight font-bold text-foreground lg:text-2xl">{market.question}</h1>
            <WatchlistButton marketId={market.id} />
          </div>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-2xl font-bold tabular-nums text-yes-foreground">
                {Math.round(priceToProbabilityBps(market.outcomes[0].pricePaise) / 100)}%
              </p>
              <p className="text-xs text-muted-foreground">chance of {market.outcomes[0].name}</p>
            </div>
            <PriceChart history={market.priceHistory} />
          </Card>

          {video ? <MarketVideo video={video} /> : null}

          <section>
            <SectionHeading title="About this market" />
            <p className="text-sm leading-relaxed text-muted-foreground">{market.description}</p>
          </section>

          <section>
            <SectionHeading title="Resolution criteria" />
            <p className="text-sm leading-relaxed text-muted-foreground">{market.resolutionCriteria}</p>
            <p className="mt-1 text-xs text-muted-foreground">Source of truth: {market.source}</p>
          </section>

          <section>
            <SectionHeading title="Recent trades" />
            <Card className="divide-y divide-border">
              {trades.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No trades have been placed yet.</p>
              ) : trades.map((trade) => {
                const outcome = market.outcomes.find((o) => o.id === trade.outcomeId)
                return (
                  <div key={trade.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-muted-foreground">{trade.trader ?? 'Trader'}</span>
                    <span className={trade.side === 'buy' ? 'text-yes-foreground' : 'text-no-foreground'}>
                      {trade.side === 'buy' ? 'Bought' : 'Sold'} {formatShares(trade.milliShares)} {outcome?.name}
                    </span>
                    <span className="tabular-nums text-foreground">{formatINR(trade.amountPaise)}</span>
                  </div>
                )
              })}
            </Card>
          </section>
        </div>

        <aside className="order-first lg:sticky lg:top-20 lg:order-none lg:self-start">
          <TradePanel market={market} initialOutcomeId={side} />
        </aside>
      </div>
    </AppShell>
  )
}
