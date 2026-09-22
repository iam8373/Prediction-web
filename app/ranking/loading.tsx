import { AppShell } from '@/components/layout/app-shell'
import { Card, Skeleton } from '@/components/ui/primitives'

/**
 * Leaderboard loading state.
 *
 * This route aggregates every trader's positions and trades, so it is the most
 * expensive read in the app and the one most likely to be seen waiting.
 */
export default function RankingLoading() {
  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="h-5 w-32" />
        </div>
        <Card className="divide-y divide-border">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-4 w-6" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-52" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </Card>
      </div>
    </AppShell>
  )
}
