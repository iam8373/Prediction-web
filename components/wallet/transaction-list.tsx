'use client'

import { useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Gift, Receipt, RefreshCw, type LucideIcon } from 'lucide-react'

import { Card, EmptyState } from '@/components/ui/primitives'
import { formatDateTime } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { Transaction, TransactionType } from '@/types'

const FILTERS: { key: 'all' | TransactionType; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'deposit', label: 'Deposits' },
  { key: 'withdrawal', label: 'Withdrawals' },
  { key: 'refund', label: 'Refunds' },
  { key: 'buy', label: 'Trades' },
  { key: 'payout', label: 'Payouts' },
  { key: 'fee', label: 'Fees' },
]

/** Users must be able to tell a settled payment from a failed one at a glance. */
function statusSuffix(status: Transaction['status']) {
  if (status === 'pending') return ' · Pending'
  if (status === 'failed') return ' · Failed'
  return ''
}

const ICONS: Record<TransactionType, LucideIcon> = {
  deposit: ArrowDownLeft,
  withdrawal: ArrowUpRight,
  buy: Receipt,
  sell: Receipt,
  payout: Gift,
  fee: RefreshCw,
  refund: RefreshCw,
  bonus: Gift,
}

export function TransactionList({ transactions }: { transactions: Transaction[] }) {
  const [filter, setFilter] = useState<'all' | TransactionType>('all')

  const filtered =
    filter === 'all'
      ? transactions
      : filter === 'buy'
        ? transactions.filter((t) => t.type === 'buy' || t.type === 'sell')
        : transactions.filter((t) => t.type === filter)

  return (
    <div className="space-y-3">
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === f.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No transactions" description="Nothing to show for this filter yet." />
      ) : (
        <Card className="divide-y divide-border">
          {filtered.map((txn) => {
            const Icon = ICONS[txn.type]
            return (
              <div key={txn.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{txn.description}</p>
                  <p className={cn('text-[11px]', txn.status === 'failed' ? 'text-no' : 'text-muted-foreground')}>
                    {formatDateTime(txn.createdAt)} · {txn.reference}
                    {statusSuffix(txn.status)}
                  </p>
                </div>
                <p
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    txn.amountPaise >= 0 ? 'text-yes-foreground' : 'text-foreground',
                  )}
                >
                  {formatINR(txn.amountPaise, { signed: true })}
                </p>
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
