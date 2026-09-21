'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { inputClass } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { formatINR, rupeesToPaise } from '@/lib/money'
import { useAppStore } from '@/lib/store/use-app-store'
import { cn } from '@/lib/utils'

const MODE_COPY: Record<string, string> = {
  demo: 'Your funds are reserved while the demo payout is processed. No real money moves.',
  sandbox: 'Your funds are reserved while the sandbox payout is processed, then released by a signed provider webhook.',
  live: 'Your funds are reserved while the payout is processed by the payment provider.',
}

export function WithdrawModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useAppStore((s) => s.wallet)
  const withdraw = useAppStore((s) => s.withdraw)
  const paymentsSummary = useAppStore((s) => s.paymentsSummary)
  const { toast } = useToast()
  const [amount, setAmount] = useState(200)
  const [destination, setDestination] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const exceeds = rupeesToPaise(amount) > wallet.availablePaise

  async function submit() {
    if (destination.trim().length < 4) {
      toast({ title: 'Enter a valid UPI ID', tone: 'error' })
      return
    }
    setSubmitting(true)
    const result = await withdraw(rupeesToPaise(amount), destination.trim())
    setSubmitting(false)
    if (result.ok) {
      const completed = result.paymentStatus === 'completed'
      toast({
        title: completed ? 'Withdrawal completed' : 'Withdrawal requested',
        description: completed
          ? `${formatINR(rupeesToPaise(amount))} sent to ${destination.trim()}`
          : result.reviewRequired
            ? `${formatINR(rupeesToPaise(amount))} stays reserved while we confirm this payout with the provider`
            : `${formatINR(rupeesToPaise(amount))} is reserved for ${destination.trim()} until the payout settles`,
        tone: completed ? 'success' : 'info',
      })
      onClose()
    } else {
      toast({ title: 'Withdrawal failed', description: result.error, tone: 'error' })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Withdraw funds"
      description={MODE_COPY[paymentsSummary?.mode ?? 'demo']}
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Available balance: <span className="font-semibold text-foreground">{formatINR(wallet.availablePaise)}</span>
        </p>
        <div>
          <label htmlFor="withdraw-amount" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Amount
          </label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
              ₹
            </span>
            <input
              id="withdraw-amount"
              type="number"
              min={200}
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
              className={cn(inputClass, 'pl-7 text-base font-semibold')}
              data-autofocus
            />
          </div>
          {exceeds ? <p className="mt-1.5 text-xs font-medium text-no">Amount exceeds your available balance</p> : null}
        </div>
        <div>
          <label htmlFor="destination" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            UPI ID
          </label>
          <input
            id="destination"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="yourname@upi"
            className={inputClass}
          />
        </div>
        <Button
          className="h-11 w-full rounded-xl text-[15px]"
          disabled={submitting || amount < 200 || exceeds}
          onClick={submit}
        >
          {submitting ? 'Processing…' : `Withdraw ${formatINR(rupeesToPaise(amount || 0))}`}
        </Button>
      </div>
    </Modal>
  )
}
