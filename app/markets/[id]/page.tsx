import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { AppShell } from '@/components/layout/app-shell'
import { PriceChart } from '@/components/charts/price-chart'
import { MarketStatusHeader } from '@/components/markets/market-status-header'
import { WatchlistButton } from '@/components/markets/watchlist-button'
import { TradePanel } from '@/components/trading/trade-panel'
import { Card, SectionHeading } from '@/components/ui/primitives'
import { getMarket, marketStats, recentTradesFromDb } from '@/lib/data/server-api'
import { formatINR, formatShares } from '@/lib/money'
import { priceToProbabilityBps } from '@/lib/trading/pricing'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const market = await getMarket(id)
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
  const market = await getMarket(id)
  if (!market) notFound()

  const [trades, stats] = await Promise.all([
    recentTradesFromDb(market, 8),
    marketStats(market.id),
  ])

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
