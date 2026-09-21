'use client'

import { Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { inputClass, StatTile } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/toast'
import { formatINR, formatShares, rupeesToPaise } from '@/lib/money'
import { useEffectiveMarket } from '@/lib/store/selectors'
import { useAppStore } from '@/lib/store/use-app-store'
import { formatMultiplier, quoteBuy, quoteSell } from '@/lib/trading/pricing'
import { cn } from '@/lib/utils'
import type { Market } from '@/types'

const QUICK_AMOUNTS = [10, 50, 100, 500]

export function TradePanel({
  market: staticMarket,
  initialOutcomeId,
}: {
  market: Market
  initialOutcomeId?: string
}) {
  const market = useEffectiveMarket(staticMarket)
  const router = useRouter()
  const { toast } = useToast()
  const user = useAppStore((s) => s.user)
  const wallet = useAppStore((s) => s.wallet)
  const positions = useAppStore((s) => s.positions)
  const buy = useAppStore((s) => s.buy)
  const sell = useAppStore((s) => s.sell)

  const validInitial = market.outcomes.some((o) => o.id === initialOutcomeId)
  const [mode, setMode] = useState<'buy' | 'sell'>('buy')
  const [outcomeId, setOutcomeId] = useState(validInitial ? initialOutcomeId! : market.outcomes[0].id)
  const [amountRupees, setAmountRupees] = useState(50)
  const [sellShares, setSellShares] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const outcome = market.outcomes.find((o) => o.id === outcomeId) ?? market.outcomes[0]
  const openPosition = positions.find((p) => p.outcomeId === outcome.id && p.status === 'open')
  const sellMilliShares = Math.round(sellShares * 1000)
  const closed = market.status !== 'open'

  // The same quote functions the buy and sell routes use, with the same market
  // liquidity, so the preview cannot disagree with the price actually filled.
  const buyQuote = useMemo(
    () => quoteBuy(rupeesToPaise(amountRupees || 0), outcome.pricePaise, market.liquidityPaise),
    [amountRupees, outcome.pricePaise, market.liquidityPaise],
  )
  const sellQuote = useMemo(
    () =>
      openPosition
        ? quoteSell(sellMilliShares, outcome.pricePaise, openPosition.averagePricePaise, market.liquidityPaise)
        : null,
    [sellMilliShares, outcome.pricePaise, openPosition, market.liquidityPaise],
  )

  const insufficientBalance = Boolean(user) && mode === 'buy' && rupeesToPaise(amountRupees) > wallet.availablePaise

  function handleReview() {
    if (!user) {
      router.push('/login')
      return
    }
    setConfirmOpen(true)
  }

  async function handleConfirm() {
    setSubmitting(true)
    const result =
      mode === 'buy'
        ? await buy(market.id, outcome.id, rupeesToPaise(amountRupees))
        : await sell(market.id, outcome.id, sellMilliShares)
    setSubmitting(false)
    setConfirmOpen(false)
    if (result.ok) {
      toast({
        title: mode === 'buy' ? 'Trade placed' : 'Position sold',
        description:
          mode === 'buy'
            ? `Bought ${formatShares(buyQuote.milliShares)} shares of ${outcome.name}`
            : `Sold ${sellShares} shares of ${outcome.name}`,
        tone: 'success',
      })
      router.refresh()
      setAmountRupees(50)
      setSellShares(0)
    } else {
      toast({ title: 'Trade failed', description: result.error, tone: 'error' })
    }
  }

  if (closed) {
    const message =
      market.status === 'resolved'
        ? 'This market has been resolved. Trading is closed.'
        : market.status === 'paused'
          ? 'Trading is paused for this market. Check back soon.'
          : 'Trading is closed for this market.'
    return (
      <div className="rounded-2xl border border-border bg-card p-4 text-center text-sm text-muted-foreground">
        {message}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4">
      <div className="grid grid-cols-2 gap-2">
        {market.outcomes.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => setOutcomeId(o.id)}
            className={cn(
              'flex h-11 items-center justify-center rounded-xl border text-[15px] font-semibold transition-all',
              o.side === 'yes'
                ? 'border-yes/20 bg-yes-soft text-yes-foreground'
                : 'border-no/20 bg-no-soft text-no-foreground',
              outcome.id === o.id
                ? o.side === 'yes'
                  ? 'ring-2 ring-yes/40'
                  : 'ring-2 ring-no/40'
                : 'opacity-60',
            )}
          >
            {o.name} · {formatMultiplier(o.pricePaise)}
          </button>
        ))}
      </div>

      <div className="flex rounded-full bg-muted p-1 text-sm font-semibold">
        <button
          type="button"
          onClick={() => setMode('buy')}
          className={cn('flex-1 rounded-full py-1.5 transition-colors', mode === 'buy' && 'bg-card shadow-sm')}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => setMode('sell')}
          disabled={!openPosition}
          className={cn(
            'flex-1 rounded-full py-1.5 transition-colors disabled:opacity-40',
            mode === 'sell' && 'bg-card shadow-sm',
          )}
        >
          Sell
        </button>
      </div>

      {mode === 'buy' ? (
        <div className="space-y-3">
          <div>
            <label htmlFor="amount" className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Amount
            </label>
            <div className="relative">
              <span className="absolute top-1/2 left-3.5 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
                ₹
              </span>
              <input
                id="amount"
                type="number"
                min={1}
                value={amountRupees}
                onChange={(e) => setAmountRupees(Math.max(0, Number(e.target.value)))}
                className={cn(inputClass, 'pl-7 text-base font-semibold')}
              />
            </div>
            <div className="mt-2 flex gap-1.5">
              {QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setAmountRupees(amt)}
                  className="flex-1 rounded-lg border border-border py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                >
                  ₹{amt}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Est. shares" value={formatShares(buyQuote.milliShares)} />
            <StatTile label="Your price" value={formatMultiplier(buyQuote.pricePaise)} />
            <StatTile label="Potential payout" value={formatINR(buyQuote.grossPayoutPaise)} tone="yes" />
            <StatTile
              label="Potential profit"
              value={formatINR(buyQuote.profitPaise, { signed: true })}
              tone={buyQuote.profitPaise >= 0 ? 'yes' : 'no'}
            />
          </div>

          {insufficientBalance ? (
            <p className="text-xs font-medium text-no">
              Insufficient balance. Available: {formatINR(wallet.availablePaise)}
            </p>
          ) : null}

          <Button
            className="h-11 w-full rounded-xl text-[15px]"
            disabled={amountRupees <= 0 || insufficientBalance}
            onClick={handleReview}
          >
            {user ? `Buy ${outcome.name}` : 'Sign in to trade'}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {openPosition ? (
            <>
              <div>
                <label htmlFor="shares" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Shares to sell (you hold {formatShares(openPosition.milliShares)})
                </label>
                <input
                  id="shares"
                  type="number"
                  min={0}
                  max={openPosition.milliShares / 1000}
                  step={0.001}
                  value={sellShares}
                  onChange={(e) => setSellShares(Math.max(0, Number(e.target.value)))}
                  className={cn(inputClass, 'text-base font-semibold')}
                />
                <button
                  type="button"
                  onClick={() => setSellShares(openPosition.milliShares / 1000)}
                  className="mt-1.5 text-xs font-semibold text-primary"
                >
                  Sell all
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <StatTile label="You receive" value={formatINR(sellQuote?.netValuePaise ?? 0)} />
                <StatTile
                  label="P&L"
                  value={formatINR(sellQuote?.pnlPaise ?? 0, { signed: true })}
                  tone={(sellQuote?.pnlPaise ?? 0) >= 0 ? 'yes' : 'no'}
                />
              </div>
              <Button
                className="h-11 w-full rounded-xl text-[15px]"
                variant="secondary"
                disabled={sellMilliShares <= 0}
                onClick={handleReview}
              >
                Sell {outcome.name}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">You do not hold this outcome yet.</p>
          )}
        </div>
      )}

      <p className="text-center text-[11px] text-muted-foreground">
        Demo balances. 2% platform fee applies to winnings.
      </p>

      <Modal
        open={confirmOpen}
        onClose={() => (submitting ? null : setConfirmOpen(false))}
        title={mode === 'buy' ? `Confirm buy · ${outcome.name}` : `Confirm sell · ${outcome.name}`}
        description={market.question}
        footer={
          <Button
            className="h-11 w-full rounded-xl text-[15px]"
            variant={mode === 'sell' ? 'secondary' : 'default'}
            disabled={submitting}
            onClick={handleConfirm}
            data-autofocus
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {mode === 'buy' ? `Confirm ₹${amountRupees} buy` : `Confirm sell`}
          </Button>
        }
      >
        {mode === 'buy' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="Amount" value={formatINR(rupeesToPaise(amountRupees))} />
              <StatTile label="Price per share" value={formatMultiplier(buyQuote.pricePaise)} />
              <StatTile label="Shares" value={formatShares(buyQuote.milliShares)} />
              <StatTile label="Potential payout" value={formatINR(buyQuote.grossPayoutPaise)} tone="yes" />
              <StatTile
                label="Potential profit"
                value={formatINR(buyQuote.profitPaise, { signed: true })}
                tone={buyQuote.profitPaise >= 0 ? 'yes' : 'no'}
              />
              <StatTile label="Fee on winnings" value={formatINR(buyQuote.feePaise)} />
            </div>
            <p className="text-xs text-muted-foreground">
              This places a demo order at the price shown. Larger orders fill further from the
              market price, and prices can move before you confirm.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="Shares" value={sellShares.toString()} />
              <StatTile label="Price per share" value={formatMultiplier(sellQuote?.pricePaise ?? outcome.pricePaise)} />
              <StatTile label="You receive" value={formatINR(sellQuote?.netValuePaise ?? 0)} />
              <StatTile
                label="P&L"
                value={formatINR(sellQuote?.pnlPaise ?? 0, { signed: true })}
                tone={(sellQuote?.pnlPaise ?? 0) >= 0 ? 'yes' : 'no'}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              This closes part or all of your position at the price shown, which is below the
              market price by this order&apos;s slippage.
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}
