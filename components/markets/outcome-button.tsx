'use client'

import { formatSharePrice } from '@/lib/money'
import { formatMultiplier } from '@/lib/trading/pricing'
import { cn } from '@/lib/utils'
import type { MarketOutcome } from '@/types'

interface OutcomeButtonProps {
  outcome: MarketOutcome
  onSelect?: (outcome: MarketOutcome) => void
  disabled?: boolean
  selected?: boolean
  size?: 'sm' | 'lg'
  className?: string
}

/**
 * The Predik outcome chip: a soft green / red pill with the return multiplier
 * tucked into the top-left corner and the per-share price in the centre.
 */
export function OutcomeButton({
  outcome,
  onSelect,
  disabled,
  selected,
  size = 'sm',
  className,
}: OutcomeButtonProps) {
  const yes = outcome.side === 'yes'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.(outcome)}
      aria-label={`Trade ${outcome.name} at ${formatSharePrice(outcome.pricePaise)} per share, ${formatMultiplier(outcome.pricePaise)} return`}
      className={cn(
        'relative flex w-full items-center justify-center overflow-hidden rounded-xl border font-semibold transition-all focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50',
        size === 'sm' ? 'h-11 text-[15px]' : 'h-14 text-base',
        yes
          ? 'border-yes/20 bg-yes-soft text-yes-foreground hover:border-yes/40'
          : 'border-no/20 bg-no-soft text-no-foreground hover:border-no/40',
        selected && (yes ? 'border-yes ring-2 ring-yes/30' : 'border-no ring-2 ring-no/30'),
        !disabled && 'active:translate-y-px',
        className,
      )}
    >
      <span
        className={cn(
          'absolute top-0 left-0 rounded-br-lg px-1.5 py-0.5 text-[10px] leading-3 font-bold',
          yes ? 'bg-yes/15 text-yes-foreground' : 'bg-no/15 text-no-foreground',
        )}
      >
        {formatMultiplier(outcome.pricePaise)}
      </span>
      <span className="truncate px-6">
        {outcome.name} {formatSharePrice(outcome.pricePaise)}
      </span>
    </button>
  )
}
