import { Card, Skeleton } from '@/components/ui/primitives'

/**
 * Placeholder cards for a market grid.
 *
 * Used by the route loading states so a page that is waiting on the database (or
 * on a provider) shows the shape of what is coming instead of a blank screen or
 * the "temporarily unavailable" fallback — a slow read is not an outage.
 */
export function MarketGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <div className="flex items-center justify-between gap-3 pt-1">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
          </div>
        </Card>
      ))}
    </div>
  )
}
