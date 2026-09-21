import { Trophy } from 'lucide-react'

import { AppShell } from '@/components/layout/app-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { Card } from '@/components/ui/primitives'
import { leaderboardFromDb } from '@/lib/data/server-api'
import { loadOrUnavailable } from '@/lib/db/availability'
import { formatCompactINR, formatPercent } from '@/lib/money'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Leaderboard · Predik',
  description: 'See the highest earning traders on Predik this week.',
}

export default async function RankingPage() {
  // A database that cannot be read must produce a page, not an empty 500.
  const loaded = await loadOrUnavailable('leaderboard', () => leaderboardFromDb())

  if (!loaded.ok) {
    return (
      <AppShell>
        <ServiceUnavailable reason={loaded.reason} />
      </AppShell>
    )
  }

  const rows = loaded.value

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Trophy className="size-5 text-primary" />
          <h1 className="text-lg font-bold text-foreground">Leaderboard</h1>
        </div>
        <Card className="divide-y divide-border">
          {rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Leaderboard results will appear after traders complete a market.</p>
          ) : rows.map((row) => (
            <div key={row.rank} className="flex items-center gap-3 px-4 py-3">
              <span className="w-6 shrink-0 text-sm font-bold text-muted-foreground">#{row.rank}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{row.name}</p>
                <p className="text-xs text-muted-foreground">
                  {formatCompactINR(row.volumePaise)} traded · {formatPercent(row.accuracyBps)} accuracy
                </p>
              </div>
              <p className="shrink-0 text-sm font-bold tabular-nums text-yes-foreground">
                {row.pnlPaise >= 0 ? '+' : ''}{formatCompactINR(row.pnlPaise)}
              </p>
            </div>
          ))}
        </Card>
      </div>
    </AppShell>
  )
}
