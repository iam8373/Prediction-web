'use client'

import { AppShell } from '@/components/layout/app-shell'
import { PositionCard } from '@/components/portfolio/position-card'
import { AuthGate } from '@/components/trading/auth-gate'
import { StatTile } from '@/components/ui/primitives'
import { formatINR } from '@/lib/money'
import { enrichPositions, summarisePortfolio } from '@/lib/store/selectors'
import { useAppStore } from '@/lib/store/use-app-store'

export default function PortfolioPage() {
  const user = useAppStore((s) => s.user)
  const wallet = useAppStore((s) => s.wallet)
  const positions = useAppStore((s) => s.positions)
  const markets = useAppStore((s) => s.markets)

  if (!user) {
    return (
      <AppShell>
        <AuthGate message="Sign in to view your positions and portfolio performance." />
      </AppShell>
    )
  }

  const rows = enrichPositions(positions, markets)
  const open = rows.filter((r) => r.position.status === 'open')
  const settled = rows.filter((r) => r.position.status !== 'open')
  const summary = summarisePortfolio(rows, wallet.availablePaise)

  return (
    <AppShell>
      <div className="space-y-5">
        <h1 className="text-lg font-bold text-foreground">Portfolio</h1>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Total value" value={formatINR(summary.totalValuePaise)} />
          <StatTile label="Invested" value={formatINR(summary.investedPaise)} />
          <StatTile
            label="Unrealised P&L"
            value={formatINR(summary.unrealisedPnlPaise, { signed: true })}
            tone={summary.unrealisedPnlPaise >= 0 ? 'yes' : 'no'}
          />
          <StatTile
            label="Realised P&L"
            value={formatINR(summary.realisedPnlPaise, { signed: true })}
            tone={summary.realisedPnlPaise >= 0 ? 'yes' : 'no'}
          />
        </div>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Open positions ({open.length})</h2>
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open positions yet. Find a market to trade.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {open.map((row) => (
                <PositionCard key={row.position.id} row={row} />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Resolved positions ({settled.length})</h2>
          {settled.length === 0 ? (
            <p className="text-sm text-muted-foreground">No resolved positions yet.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {settled.map((row) => (
                <PositionCard key={row.position.id} row={row} />
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  )
}
