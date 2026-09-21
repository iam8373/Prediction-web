import Link from 'next/link'

import { Badge, Card } from '@/components/ui/primitives'
import { formatINR, formatShares } from '@/lib/money'
import type { EnrichedPosition } from '@/lib/store/selectors'
import { cn } from '@/lib/utils'

export function PositionCard({ row }: { row: EnrichedPosition }) {
  const { position, market, outcome, currentValuePaise, unrealisedPnlPaise, resolvedWon } = row
  const settled = position.status !== 'open'
  const pnl = settled ? position.realisedPnlPaise : unrealisedPnlPaise

  return (
    <Link href={`/markets/${market.slug}`}>
      <Card className="flex flex-col gap-2 p-4 transition-shadow hover:shadow-md">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="line-clamp-1 text-sm font-semibold text-foreground">{market.headline}</p>
            <p className="line-clamp-1 text-xs text-muted-foreground">{market.question}</p>
          </div>
          <Badge tone={outcome.side === 'yes' ? 'yes' : 'no'}>{outcome.name}</Badge>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Shares</p>
            <p className="font-semibold tabular-nums">{formatShares(position.milliShares)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Avg. price</p>
            <p className="font-semibold tabular-nums">{formatINR(position.averagePricePaise)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">{settled ? 'Result' : 'Current value'}</p>
            <p className="font-semibold tabular-nums">
              {settled ? (resolvedWon ? 'Won' : 'Lost') : formatINR(currentValuePaise)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">P&amp;L</p>
            <p className={cn('font-semibold tabular-nums', pnl >= 0 ? 'text-yes-foreground' : 'text-no-foreground')}>
              {formatINR(pnl, { signed: true })}
            </p>
          </div>
        </div>
      </Card>
    </Link>
  )
}
