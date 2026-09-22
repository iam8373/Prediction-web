import { AppShell } from '@/components/layout/app-shell'
import { Card, Skeleton } from '@/components/ui/primitives'

/**
 * Market detail loading state.
 *
 * The heaviest page in the app: it reads the market, its price history, its
 * recent trades and its statistics, and it may also look up the video the market
 * is about. The skeleton mirrors that layout — chart, sections, trade panel — so
 * the page settles rather than reflowing.
 */
export default function MarketDetailLoading() {
  return (
    <AppShell>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-6 w-4/5" />

          <Card className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-7 w-16" />
              <Skeleton className="h-4 w-28" />
            </div>
            <Skeleton className="h-40 w-full" />
          </Card>

          <div className="space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>

          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Card className="divide-y divide-border">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="flex items-center justify-between px-4 py-2.5">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </Card>
          </div>
        </div>

        <aside className="order-first lg:order-none">
          <Card className="space-y-3 p-4">
            <Skeleton className="h-4 w-24" />
            <div className="flex gap-2">
              <Skeleton className="h-10 flex-1" />
              <Skeleton className="h-10 flex-1" />
            </div>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </Card>
        </aside>
      </div>
    </AppShell>
  )
}
