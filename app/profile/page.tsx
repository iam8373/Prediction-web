'use client'

import { LogOut, Settings2, ShieldCheck, UserRound } from 'lucide-react'
import Link from 'next/link'

import { AppShell } from '@/components/layout/app-shell'
import { AuthGate } from '@/components/trading/auth-gate'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/primitives'
import { formatDate } from '@/lib/date'
import { formatCount, formatINR } from '@/lib/money'
import { useAppStore } from '@/lib/store/use-app-store'

export default function ProfilePage() {
  const user = useAppStore((s) => s.user)
  const wallet = useAppStore((s) => s.wallet)
  const profileStats = useAppStore((s) => s.profileStats)
  const signOut = useAppStore((s) => s.signOut)

  if (!user) {
    return (
      <AppShell>
        <AuthGate message="Sign in to manage your account." />
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="space-y-5">
        <Card className="flex items-center gap-4 p-5">
          <span
            className="grid size-14 place-items-center rounded-full text-lg font-bold text-white"
            style={{ background: user.avatarColor }}
          >
            {user.name.slice(-2)}
          </span>
          <div>
            <p className="text-base font-bold text-foreground">{user.name}</p>
            <p className="text-sm text-muted-foreground">+91 {user.phone}</p>
            <p className="text-xs text-muted-foreground">Member since {formatDate(user.joinedAt)}</p>
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-2">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Wallet balance</p>
            <p className="mt-1 text-lg font-bold">{formatINR(wallet.availablePaise)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Account type</p>
            <p className="mt-1 text-lg font-bold">{user.isAdmin ? 'Admin' : 'Trader'}</p>
          </Card>
        </div>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Trading stats</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Trades</p>
              <p className="mt-1 text-lg font-bold tabular-nums">{formatCount(profileStats.tradeCount)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Markets</p>
              <p className="mt-1 text-lg font-bold tabular-nums">{formatCount(profileStats.marketsParticipated)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Open positions</p>
              <p className="mt-1 text-lg font-bold tabular-nums">{profileStats.openPositions}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Volume</p>
              <p className="mt-1 text-lg font-bold tabular-nums">{formatINR(profileStats.volumePaise, { whole: true })}</p>
            </Card>
          </div>
        </section>

        <Card className="divide-y divide-border">
          <Link href="/wallet" className="flex items-center gap-3 px-4 py-3 text-sm font-medium hover:bg-muted/60">
            <UserRound className="size-4 text-muted-foreground" /> Wallet &amp; transactions
          </Link>
          {user.isAdmin ? (
            <Link href="/admin" className="flex items-center gap-3 px-4 py-3 text-sm font-medium hover:bg-muted/60">
              <Settings2 className="size-4 text-muted-foreground" /> Admin panel
            </Link>
          ) : null}
          <div className="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
            <ShieldCheck className="size-4" /> Demo account · no real funds
          </div>
        </Card>

        <Button variant="outline" className="h-11 w-full rounded-xl" onClick={signOut}>
          <LogOut className="size-4" /> Sign out
        </Button>
      </div>
    </AppShell>
  )
}
