'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { inputClass } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { formatINR, rupeesToPaise } from '@/lib/money'
import { isAllowedCheckoutUrl } from '@/lib/security/url-safety'
import { useAppStore } from '@/lib/store/use-app-store'
import { cn } from '@/lib/utils'

const QUICK_AMOUNTS = [100, 500, 1000, 5000]
const METHODS = ['upi', 'netbanking', 'demo'] as const

const MODE_COPY: Record<string, string> = {
  demo: 'Demo deposits settle instantly. No real money is used.',
  sandbox: 'Sandbox deposits are confirmed by a signed provider webhook. No real money moves.',
  live: 'Live deposits move real money and are settled by the payment provider.',
}

export function DepositModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const deposit = useAppStore((s) => s.deposit)
  const paymentsSummary = useAppStore((s) => s.paymentsSummary)
  const { toast } = useToast()
  const [amount, setAmount] = useState(500)
  const [method, setMethod] = useState<(typeof METHODS)[number]>('upi')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    const result = await deposit(rupeesToPaise(amount), method)
    setSubmitting(false)
    if (!result.ok) {
      toast({ title: 'Deposit failed', description: result.error, tone: 'error' })
      return
    }

    // The wallet is credited only once the provider confirms the payment. In
    // sandbox/live mode that confirmation arrives through a signed webhook, so
    // the payment comes back pending and is settled from provider truth.
    const settled = result.paymentStatus === 'completed'
    // Defence in depth: the server already only returns a vetted provider host,
    // and the browser refuses anything else rather than following it blindly.
    const checkoutUrl = isAllowedCheckoutUrl(result.checkoutUrl) ? result.checkoutUrl : undefined
    if (checkoutUrl) {
      toast({
        title: 'Continuing to your provider',
        description: 'Finish the payment on the provider’s secure page. Your wallet updates automatically.',
        tone: 'info',
      })
      // Provider-hosted checkout: card/UPI details never pass through Predik.
      window.location.assign(checkoutUrl)
      return
    }
    toast({
      title: settled ? 'Funds added' : 'Deposit pending',
      description: result.reviewRequired
        ? 'We are checking this payment against the provider before crediting your wallet.'
        : settled
          ? `${formatINR(rupeesToPaise(amount))} credited to your wallet`
          : `We are waiting for the provider to confirm ${formatINR(rupeesToPaise(amount))}`,
      tone: settled && !result.reviewRequired ? 'success' : 'info',
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add funds"
      description={MODE_COPY[paymentsSummary?.mode ?? 'demo']}
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Your wallet is credited only after the payment provider confirms the payment — never when this page opens.
        </p>
        <div>
          <label htmlFor="deposit-amount" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Amount
          </label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
              ₹
            </span>
            <input
              id="deposit-amount"
              type="number"
              min={100}
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
              className={cn(inputClass, 'pl-7 text-base font-semibold')}
              data-autofocus
            />
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {QUICK_AMOUNTS.map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setAmount(amt)}
                className={cn(
                  'rounded-lg border py-1.5 text-xs font-medium transition-colors',
                  amount === amt
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                ₹{amt}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Payment method</p>
          <div className="grid grid-cols-3 gap-1.5">
            {METHODS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={cn(
                  'rounded-lg border py-2 text-xs font-semibold uppercase transition-colors',
                  method === m
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <Button
          className="h-11 w-full rounded-xl text-[15px]"
          disabled={submitting || amount < 100}
          onClick={submit}
        >
          {submitting ? 'Processing…' : `Add ${formatINR(rupeesToPaise(amount || 0))}`}
        </Button>
      </div>
    </Modal>
  )
}
