'use client'

import { useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, RefreshCw, ShieldAlert, type LucideIcon } from 'lucide-react'

import { Badge, Card, EmptyState } from '@/components/ui/primitives'
import { formatDateTime } from '@/lib/date'
import { formatINR } from '@/lib/money'
import { cn } from '@/lib/utils'
import type { PaymentDirection, PaymentRecord } from '@/types'

/**
 * Payment requests for the signed-in user. Complements the transaction list
 * (which shows the wallet movements) by exposing the payment's own lifecycle:
 * provider reference, refund status and reconciliation status.
 */

const FILTERS: { key: 'all' | PaymentDirection | 'review'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'deposit', label: 'Deposits' },
  { key: 'withdrawal', label: 'Withdrawals' },
  { key: 'refund', label: 'Refunds' },
  { key: 'review', label: 'Needs review' },
]

const ICONS: Record<PaymentDirection, LucideIcon> = {
  deposit: ArrowDownLeft,
  withdrawal: ArrowUpRight,
  refund: RefreshCw,
}

const LABELS: Record<PaymentDirection, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  refund: 'Refund',
}

/** A payment is final once it can no longer change on its own. */
function isFinal(status: PaymentRecord['status']) {
  return status === 'completed' || status === 'refunded' || status === 'partially_refunded' || status === 'failed'
    || status === 'cancelled' || status === 'expired'
}

function statusTone(status: PaymentRecord['status']): 'neutral' | 'yes' | 'no' | 'warning' | 'brand' {
  switch (status) {
    case 'completed':
      return 'yes'
    case 'refunded':
    case 'partially_refunded':
      return 'brand'
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'no'
    default:
      return 'warning'
  }
}

function statusLabel(status: PaymentRecord['status']) {
  switch (status) {
    case 'created':
      return 'Created'
    case 'pending':
      return 'Pending'
    case 'processing':
      return 'Processing'
    case 'verified':
      return 'Confirmed · settling'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'expired':
      return 'Expired'
    case 'refunded':
      return 'Refunded'
    case 'partially_refunded':
      return 'Partially refunded'
  }
}

export function PaymentList({ payments }: { payments: PaymentRecord[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all')

  const filtered = payments.filter((payment) => {
    if (filter === 'all') return true
    if (filter === 'review') return payment.reconciliationStatus !== 'unchecked' && payment.reconciliationStatus !== 'matched'
    return payment.direction === filter
  })

  return (
    <div className="space-y-3">
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
        {FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setFilter(option.key)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === option.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No payments"
          description="Deposits, withdrawals and refunds will appear here with their provider reference."
        />
      ) : (
        <Card className="divide-y divide-border">
          {filtered.map((payment) => {
            const Icon = ICONS[payment.direction]
            const signed = payment.direction === 'withdrawal' ? -payment.amountPaise : payment.amountPaise
            return (
              <div key={payment.id} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-sm font-medium text-foreground">{LABELS[payment.direction]}</p>
                    <Badge tone={statusTone(payment.status)}>{statusLabel(payment.status)}</Badge>
                    {payment.refundStatus !== 'none' ? <Badge tone="brand">Refunded</Badge> : null}
                    {payment.reconciliationStatus !== 'unchecked' && payment.reconciliationStatus !== 'matched' ? (
                      <Badge tone="warning">
                        <ShieldAlert className="size-3" />
                        {payment.reconciliationStatus.replace(/_/g, ' ')}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {formatDateTime(payment.createdAt)} · {payment.provider}
                    {payment.providerReference ? ` · ${payment.providerReference}` : ''}
                    {payment.providerPaymentId ? ` · ${payment.providerPaymentId}` : ''}
                  </p>
                  {payment.failureReason ? (
                    <p className="mt-1 text-[11px] text-no">{payment.failureReason}</p>
                  ) : null}
                  {!isFinal(payment.status) && payment.checkoutUrl ? (
                    <a
                      href={payment.checkoutUrl}
                      className="mt-1.5 inline-block text-[11px] font-semibold text-primary underline-offset-2 hover:underline"
                    >
                      Finish this payment on the provider’s page →
                    </a>
                  ) : null}
                </div>
                <p
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    signed >= 0 ? 'text-yes-foreground' : 'text-foreground',
                  )}
                >
                  {formatINR(signed, { signed: true })}
                </p>
              </div>
            )
          })}
        </Card>
      )}
    </div>
  )
}
