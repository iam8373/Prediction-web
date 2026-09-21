'use client'

import { ArrowDownToLine, ArrowUpFromLine, Clock, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { AuthGate } from '@/components/trading/auth-gate'
import { Button } from '@/components/ui/button'
import { Badge, Card } from '@/components/ui/primitives'
import { DepositModal } from '@/components/wallet/deposit-modal'
import { PaymentList } from '@/components/wallet/payment-list'
import { TransactionList } from '@/components/wallet/transaction-list'
import { WithdrawModal } from '@/components/wallet/withdraw-modal'
import { formatINR } from '@/lib/money'
import { useAppStore } from '@/lib/store/use-app-store'

export default function WalletPage() {
  const user = useAppStore((s) => s.user)
  const wallet = useAppStore((s) => s.wallet)
  const transactions = useAppStore((s) => s.transactions)
  const payments = useAppStore((s) => s.payments)
  const paymentsSummary = useAppStore((s) => s.paymentsSummary)
  const refreshPayments = useAppStore((s) => s.refreshPayments)
  const [depositOpen, setDepositOpen] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Money that the provider has not confirmed yet is NOT spendable, so the
  // wallet says so explicitly instead of looking settled.
  const awaitingProvider = payments.filter(
    (payment) => payment.direction === 'deposit' && !['completed', 'failed', 'cancelled', 'expired'].includes(payment.status),
  )

  async function refresh() {
    setRefreshing(true)
    await refreshPayments()
    setRefreshing(false)
  }

  if (!user) {
    return (
      <AppShell>
        <AuthGate message="Sign in to manage your wallet, deposits and withdrawals." />
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="space-y-5">
        <h1 className="text-lg font-bold text-foreground">Wallet</h1>

        <Card className="p-5">
          <p className="text-xs text-muted-foreground">Available balance</p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-foreground">{formatINR(wallet.availablePaise)}</p>
          <div className="mt-4 flex gap-2">
            <Button className="h-10 flex-1 rounded-xl" onClick={() => setDepositOpen(true)}>
              <ArrowDownToLine className="size-4" /> Add funds
            </Button>
            <Button variant="outline" className="h-10 flex-1 rounded-xl" onClick={() => setWithdrawOpen(true)}>
              <ArrowUpFromLine className="size-4" /> Withdraw
            </Button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-sm">
            <div>
              <p className="text-muted-foreground">Locked in withdrawals</p>
              <p className="font-semibold">{formatINR(wallet.lockedPaise)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Bonus credit</p>
              <p className="font-semibold">{formatINR(wallet.bonusPaise)}</p>
              {/* Stated explicitly because the credit is a reward, not spendable funds. */}
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Rewards only — it cannot be staked on a trade or withdrawn.
              </p>
            </div>
          </div>
        </Card>

        {paymentsSummary ? (
          <Card className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Payment mode · {paymentsSummary.providerLabel}</p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">
                {paymentsSummary.mode === 'live'
                  ? 'Live money — real funds'
                  : paymentsSummary.mode === 'sandbox'
                    ? 'Sandbox — provider connected, no real money'
                    : 'Demo money — no real funds move'}
              </p>
              {paymentsSummary.mutationBlocked ? (
                <p className="mt-0.5 text-[11px] text-warning">
                  Payments are paused on this deployment. No money can move until the payment configuration is completed —
                  contact support if you were mid-payment.
                </p>
              ) : !paymentsSummary.liveEnabled ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Live payments are disabled until compliance and provider prerequisites are confirmed.
                </p>
              ) : null}
            </div>
            <Badge tone={paymentsSummary.mode === 'live' ? 'live' : 'warning'}>
              {paymentsSummary.mode.toUpperCase()}
            </Badge>
          </Card>
        ) : null}

        {awaitingProvider.length > 0 ? (
          <Card className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Clock className="size-4 text-warning" />
                {awaitingProvider.length === 1 ? '1 deposit awaiting confirmation' : `${awaitingProvider.length} deposits awaiting confirmation`}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                These funds are not in your spendable balance yet. They are credited the moment the payment provider confirms them.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
              <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
              Refresh
            </Button>
          </Card>
        ) : null}

        <section>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Transactions</h2>
          <TransactionList transactions={transactions} />
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Payments</h2>
          <PaymentList payments={payments} />
        </section>
      </div>

      <DepositModal open={depositOpen} onClose={() => setDepositOpen(false)} />
      <WithdrawModal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} />
    </AppShell>
  )
}
