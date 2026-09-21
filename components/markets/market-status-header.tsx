'use client'

import { Clock, Droplets, TrendingUp, Users } from 'lucide-react'

import { Badge, Card } from '@/components/ui/primitives'
import { getCategory } from '@/lib/data/categories'
import { formatDateTime, timeAgo, timeToClose } from '@/lib/date'
import { formatCompactINR, formatCount } from '@/lib/money'
import { useEffectiveMarket } from '@/lib/store/selectors'
import type { Market, MarketStats } from '@/types'

/**
 * Renders the badge row, resolution/pause banner, and the volume/liquidity/
 * traders/closes stat tiles for a market. Kept client-side so it reflects
 * session-only admin actions (resolve/pause/close) immediately.
 */
export function MarketStatusHeader({
  market: staticMarket,
  stats,
}: {
  market: Market
  stats?: MarketStats
}) {
  const market = useEffectiveMarket(staticMarket)
  const volumePaise = Math.max(market.volumePaise, stats?.volumePaise ?? 0)
  const traders = Math.max(market.traders, stats?.participants ?? 0)
  const category = getCategory(market.categoryId)
  const resolved = market.status === 'resolved'
  const halted = market.status === 'paused' || market.status === 'closed'
  const winningOutcome = market.outcomes.find((o) => o.id === market.resolvedOutcomeId)

  return (
    <>
      <div className="flex items-center gap-2">
        {category ? <Badge tone="neutral">{category.name}</Badge> : null}
        {market.live && !resolved && !halted ? <Badge tone="live">LIVE</Badge> : null}
        {resolved ? <Badge tone="brand">Resolved</Badge> : null}
        {market.status === 'paused' ? <Badge tone="warning">Paused</Badge> : null}
        {market.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : null}
      </div>

      {resolved && winningOutcome ? (
        <Card className="p-4">
          <p className="text-sm font-semibold text-foreground">Resolved · {winningOutcome.name} won</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Settled {timeAgo(market.resolvesAt)} · {market.resolutionCriteria}
          </p>
        </Card>
      ) : null}

      {!resolved && market.status === 'paused' ? (
        <Card className="p-4">
          <p className="text-sm font-semibold text-foreground">Trading paused</p>
          <p className="mt-1 text-xs text-muted-foreground">
            An admin has temporarily paused trading on this market.
          </p>
        </Card>
      ) : null}

      {!resolved && market.status === 'closed' ? (
        <Card className="p-4">
          <p className="text-sm font-semibold text-foreground">Trading closed</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This market is no longer accepting new trades and is awaiting resolution.
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <MiniStat icon={<TrendingUp className="size-3.5" />} label="Volume" value={formatCompactINR(volumePaise)} />
        <MiniStat icon={<Droplets className="size-3.5" />} label="Liquidity" value={formatCompactINR(market.liquidityPaise)} />
        <MiniStat icon={<Users className="size-3.5" />} label="Traders" value={formatCount(traders)} />
        <MiniStat icon={<TrendingUp className="size-3.5" />} label="Trades" value={formatCount(stats?.tradeCount ?? 0)} />
        <MiniStat
          icon={<Clock className="size-3.5" />}
          label={resolved || halted ? 'Closed' : 'Closes'}
          value={resolved || halted ? formatDateTime(market.closesAt) : timeToClose(market.closesAt)}
        />
      </div>
    </>
  )
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/60 px-3 py-2.5">
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {icon} {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  )
}
