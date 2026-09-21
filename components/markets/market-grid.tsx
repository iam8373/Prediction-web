import { SearchX } from 'lucide-react'

import { MarketCard } from '@/components/markets/market-card'
import { EmptyState } from '@/components/ui/primitives'
import type { Market } from '@/types'

export function MarketGrid({
  markets,
  emptyMessage,
}: {
  markets: Market[]
  emptyMessage?: string
}) {
  if (markets.length === 0) {
    return (
      <EmptyState
        icon={<SearchX className="size-8" />}
        title="No markets found"
        description={emptyMessage ?? 'Try a different search term or category.'}
      />
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {markets.map((market) => (
        <MarketCard key={market.id} market={market} />
      ))}
    </div>
  )
}
