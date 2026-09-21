'use client'

import { Clock, Users } from 'lucide-react'
import Link from 'next/link'

import { Badge, Card } from '@/components/ui/primitives'
import { getCategory } from '@/lib/data/categories'
import { isClosingSoon, timeToClose } from '@/lib/date'
import { formatCompactINR, formatCount, formatSharePrice } from '@/lib/money'
import { useEffectiveMarket } from '@/lib/store/selectors'
import { formatMultiplier } from '@/lib/trading/pricing'
import { cn } from '@/lib/utils'
import type { Market } from '@/types'

export function MarketCard({ market: staticMarket }: { market: Market }) {
  const market = useEffectiveMarket(staticMarket)
  const category = getCategory(market.categoryId)
  const [yesOutcome, noOutcome] = market.outcomes
  const resolved = market.status === 'resolved'
  const halted = market.status === 'paused' || market.status === 'closed'
  const winningOutcome = market.outcomes.find((o) => o.id === market.resolvedOutcomeId)

  return (
    <Card as="article" className="flex flex-col gap-3 p-4 transition-shadow hover:shadow-md">
      <Link href={`/markets/${market.slug}`} className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-xl text-[11px] font-bold text-white"
          style={{ background: category?.accent ?? 'oklch(0.6 0.1 200)' }}
        >
          {market.emblem.slice(0, 3)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5">
            {market.live ? <Badge tone="live">LIVE</Badge> : null}
            {category ? <Badge tone="neutral">{category.name}</Badge> : null}
            {market.status === 'paused' ? <Badge tone="warning">Paused</Badge> : null}
            {market.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : null}
          </div>
          <h3 className="line-clamp-2 text-[14px] font-semibold leading-snug text-foreground">
            {market.question}
          </h3>
        </div>
      </Link>

      {resolved ? (
        <div className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
          <span className="font-semibold text-foreground">Resolved · </span>
          <span className="text-muted-foreground">{winningOutcome?.name} won</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Link
            href={halted ? `/markets/${market.slug}` : `/markets/${market.slug}?side=${yesOutcome.id}`}
            aria-disabled={halted}
            className={cn(
              'relative flex h-11 items-center justify-center overflow-hidden rounded-xl border border-yes/20 bg-yes-soft px-2 text-[15px] font-semibold text-yes-foreground transition-colors hover:border-yes/40',
              halted && 'pointer-events-none opacity-60',
            )}
          >
            <span className="absolute top-0 left-0 rounded-br-lg bg-yes/15 px-1.5 py-0.5 text-[10px] leading-3 font-bold">
              {formatMultiplier(yesOutcome.pricePaise)}
            </span>
            <span className="truncate px-6">
              {yesOutcome.name} {formatSharePrice(yesOutcome.pricePaise)}
            </span>
          </Link>
          <Link
            href={halted ? `/markets/${market.slug}` : `/markets/${market.slug}?side=${noOutcome.id}`}
            aria-disabled={halted}
            className={cn(
              'relative flex h-11 items-center justify-center overflow-hidden rounded-xl border border-no/20 bg-no-soft px-2 text-[15px] font-semibold text-no-foreground transition-colors hover:border-no/40',
              halted && 'pointer-events-none opacity-60',
            )}
          >
            <span className="absolute top-0 left-0 rounded-br-lg bg-no/15 px-1.5 py-0.5 text-[10px] leading-3 font-bold">
              {formatMultiplier(noOutcome.pricePaise)}
            </span>
            <span className="truncate px-6">
              {noOutcome.name} {formatSharePrice(noOutcome.pricePaise)}
            </span>
          </Link>
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{formatCompactINR(market.volumePaise)} vol</span>
        <span className="flex items-center gap-1">
          <Users className="size-3" /> {formatCount(market.traders)}
        </span>
        <span className={cn('flex items-center gap-1', !resolved && isClosingSoon(market.closesAt) && 'text-warning')}>
          <Clock className="size-3" /> {resolved ? 'Closed' : timeToClose(market.closesAt)}
        </span>
      </div>
    </Card>
  )
}
