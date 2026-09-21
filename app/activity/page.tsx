'use client'

import { CheckCheck } from 'lucide-react'

import { NotificationList } from '@/components/activity/notification-list'
import { AppShell } from '@/components/layout/app-shell'
import { AuthGate } from '@/components/trading/auth-gate'
import { Button } from '@/components/ui/button'
import { TransactionList } from '@/components/wallet/transaction-list'
import { useAppStore } from '@/lib/store/use-app-store'

export default function ActivityPage() {
  const user = useAppStore((s) => s.user)
  const transactions = useAppStore((s) => s.transactions)
  const notifications = useAppStore((s) => s.notifications)
  const unreadNotifications = useAppStore((s) => s.unreadNotifications)
  const markNotificationRead = useAppStore((s) => s.markNotificationRead)
  const markAllNotificationsRead = useAppStore((s) => s.markAllNotificationsRead)

  if (!user) {
    return (
      <AppShell>
        <AuthGate message="Sign in to see your trading activity and notifications." />
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-bold text-foreground">Activity</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every trade, deposit, withdrawal and settlement on your account.
          </p>
        </div>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">Notifications</h2>
            {unreadNotifications > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => void markAllNotificationsRead()}>
                <CheckCheck className="size-3.5" /> Mark all read
              </Button>
            ) : null}
          </div>
          <NotificationList notifications={notifications} onRead={(id) => void markNotificationRead(id)} />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Transactions</h2>
          <TransactionList transactions={transactions} />
        </section>
      </div>
    </AppShell>
  )
}
