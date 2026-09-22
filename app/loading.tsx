import { AppShell } from '@/components/layout/app-shell'
import { MarketGridSkeleton } from '@/components/markets/market-grid-skeleton'
import { Card, Skeleton } from '@/components/ui/primitives'

/**
 * Home route loading state.
 *
 * The home page reads the catalogue and platform statistics on every request, so
 * this is what a visitor sees while that happens — the same layout at the same
 * size, so nothing jumps when the data arrives.
 */
export default function HomeLoading() {
  return (
    <AppShell>
      <div className="space-y-6">
        <Card className="space-y-4 p-5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-3/4" />
          <div className="flex flex-wrap gap-5 pt-1">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-20" />
          </div>
        </Card>
        <Skeleton className="h-4 w-40" />
        <MarketGridSkeleton count={6} />
      </div>
    </AppShell>
  )
}
