import { AppShell } from '@/components/layout/app-shell'
import { MarketGridSkeleton } from '@/components/markets/market-grid-skeleton'
import { Skeleton } from '@/components/ui/primitives'

/**
 * Markets list loading state.
 *
 * This route is the one most likely to wait on something external, because a
 * configured provider adds its fixtures to the catalogue before the list is
 * rendered.
 */
export default function MarketsLoading() {
  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-36" />
        </div>
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-24 shrink-0 rounded-full" />
          ))}
        </div>
        <Skeleton className="h-3 w-20" />
        <MarketGridSkeleton count={9} />
      </div>
    </AppShell>
  )
}
