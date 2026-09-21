/**
 * Pricing engine.
 *
 * This module is deliberately free of React and of any data-access code so the
 * current fixed-price model can be swapped for an order book, an AMM, an
 * external exchange or on-chain settlement without touching the UI.
 *
 * Model ("static book with slippage"):
 *   - A binary market has two outcomes whose per-share prices sum to ₹10.
 *   - A winning share settles at ₹10, a losing share settles at ₹0.
 *   - Platform fee is charged on winnings only.
 *   - Orders fill at the mid plus or minus their own slippage
 *     (`executionPricePaise`): a buy pays above the mid, a sell receives below
 *     it, and the market then moves by exactly that slippage in the direction of
 *     the trade.
 *
 * Why the slippage and not just a price move: filling at the mid and moving the
 * price afterwards made an immediate buy-then-sell profitable — the sell filled
 * at the price the buy had just pushed up, with nothing charged for the round
 * trip. It was repeatable for any amount, so a trader could mint money until the
 * market's liquidity ran out. Charging the slippage on the way in *and* out, and
 * moving the price by the same amount, means a round trip always recovers less
 * than it paid: the fill price a buy establishes is the best price the matching
 * sell can be priced against.
 */

import { SETTLEMENT_PAISE, SHARE_UNIT } from '@/lib/money'
import type { Market, MarketOutcome } from '@/types'

export const FEE_BPS = 200 // 2% on winnings
export const MIN_TRADE_PAISE = 100 // ₹1
export const MAX_TRADE_PAISE = 10_000_00 // ₹10,000 per order

export interface BuyQuote {
  amountPaise: number
  /** The price this order actually fills at — the mid plus its own slippage. */
  pricePaise: number
  /** Slippage this order paid, per share. */
  impactPaise: number
  milliShares: number
  grossPayoutPaise: number
  feePaise: number
  netPayoutPaise: number
  profitPaise: number
  multiplierBps: number
}

export interface SellQuote {
  milliShares: number
  /** The price this order actually fills at — the mid minus its own slippage. */
  pricePaise: number
  /** Slippage this order paid, per share. */
  impactPaise: number
  /** Size of the order at the mid, which is what its slippage is scaled to. */
  markValuePaise: number
  grossValuePaise: number
  feePaise: number
  netValuePaise: number
  costBasisPaise: number
  pnlPaise: number
}

/** Current price of an outcome, in paise per share. */
export function getMarketPrice(market: Market, outcomeId: string): number {
  const outcome = market.outcomes.find((o) => o.id === outcomeId)
  if (!outcome) throw new Error(`Unknown outcome ${outcomeId} on market ${market.id}`)
  return outcome.pricePaise
}

/** Implied probability in basis points (6400 = 64.00%). */
export function priceToProbabilityBps(pricePaise: number): number {
  return Math.round((pricePaise * 10_000) / SETTLEMENT_PAISE)
}

export function outcomeProbabilityBps(outcome: MarketOutcome): number {
  return priceToProbabilityBps(outcome.pricePaise)
}

/** Return multiplier in basis points (22200 = 2.22x). */
export function multiplierBps(pricePaise: number): number {
  if (pricePaise <= 0) return 0
  return Math.round((SETTLEMENT_PAISE * 10_000) / pricePaise)
}

export function formatMultiplier(pricePaise: number): string {
  return `${(multiplierBps(pricePaise) / 10_000).toFixed(2)}x`
}

/** Milli-shares purchasable with `amountPaise` at `pricePaise`. */
export function calculateShares(amountPaise: number, pricePaise: number): number {
  if (pricePaise <= 0) return 0
  return Math.floor((amountPaise * SHARE_UNIT) / pricePaise)
}

export function calculatePotentialPayout(milliShares: number): number {
  return Math.floor((milliShares * SETTLEMENT_PAISE) / SHARE_UNIT)
}

export function calculateFees(winningsPaise: number): number {
  if (winningsPaise <= 0) return 0
  return Math.floor((winningsPaise * FEE_BPS) / 10_000)
}

export function calculateSellValue(milliShares: number, pricePaise: number): number {
  return Math.floor((milliShares * pricePaise) / SHARE_UNIT)
}

export function costBasis(milliShares: number, averagePricePaise: number): number {
  return Math.floor((milliShares * averagePricePaise) / SHARE_UNIT)
}

export function quoteBuy(amountPaise: number, midPricePaise: number, liquidityPaise = 0): BuyQuote {
  // The order is sized at the price it will actually pay, so the shares bought
  // and the cash paid agree — sizing at the mid would hand the buyer shares at a
  // price the market never offered.
  const impactPaise = priceImpactPaise(amountPaise, liquidityPaise)
  const pricePaise = executionPricePaise(midPricePaise, 'buy', amountPaise, liquidityPaise)
  const milliShares = calculateShares(amountPaise, pricePaise)
  const grossPayoutPaise = calculatePotentialPayout(milliShares)
  const winnings = Math.max(0, grossPayoutPaise - amountPaise)
  const feePaise = calculateFees(winnings)
  const netPayoutPaise = grossPayoutPaise - feePaise
  return {
    amountPaise,
    pricePaise,
    impactPaise,
    milliShares,
    grossPayoutPaise,
    feePaise,
    netPayoutPaise,
    profitPaise: netPayoutPaise - amountPaise,
    multiplierBps: multiplierBps(pricePaise),
  }
}

export function quoteSell(
  milliShares: number,
  midPricePaise: number,
  averagePricePaise: number,
  liquidityPaise = 0,
): SellQuote {
  // Slippage scales with the order's size at the mid, not with its proceeds, so
  // sizing the order cannot itself change how much slippage it pays.
  const markValuePaise = calculateSellValue(milliShares, midPricePaise)
  const impactPaise = priceImpactPaise(markValuePaise, liquidityPaise)
  const pricePaise = executionPricePaise(midPricePaise, 'sell', markValuePaise, liquidityPaise)
  const grossValuePaise = calculateSellValue(milliShares, pricePaise)
  const basis = costBasis(milliShares, averagePricePaise)
  const feePaise = calculateFees(Math.max(0, grossValuePaise - basis))
  const netValuePaise = grossValuePaise - feePaise
  return {
    milliShares,
    pricePaise,
    impactPaise,
    markValuePaise,
    grossValuePaise,
    feePaise,
    netValuePaise,
    costBasisPaise: basis,
    pnlPaise: netValuePaise - basis,
  }
}

/** New volume-weighted average price after adding to a position. */
export function blendAveragePrice(
  existingMilliShares: number,
  existingAveragePaise: number,
  addedMilliShares: number,
  addedPricePaise: number,
): number {
  const total = existingMilliShares + addedMilliShares
  if (total <= 0) return addedPricePaise
  const value =
    existingMilliShares * existingAveragePaise + addedMilliShares * addedPricePaise
  return Math.round(value / total)
}

export type PriceMoveSide = 'buy' | 'sell'

/** The thinnest market still trades like one with this much liquidity, in paise. */
const MIN_MARKET_DEPTH_PAISE = SETTLEMENT_PAISE * 100

export const MIN_PRICE_IMPACT_PAISE = 1
export const MAX_PRICE_IMPACT_PAISE = 60

/**
 * Slippage this order pays, in paise per share, scaled to its size against the
 * market's liquidity: larger orders move the price further and pay more.
 *
 * At least one paise is always charged. A round trip is then strictly worse than
 * doing nothing rather than merely break-even, which is what stops a loop of
 * buy/sell pairs from being free to run.
 */
export function priceImpactPaise(notionalPaise: number, liquidityPaise: number): number {
  const notional = Number.isFinite(notionalPaise) ? Math.max(0, notionalPaise) : 0
  const liquidity = Number.isFinite(liquidityPaise) ? Math.max(0, liquidityPaise) : 0
  const depth = Math.max(liquidity, MIN_MARKET_DEPTH_PAISE)
  const scaled = Math.round((notional * 100) / depth)
  return Math.min(MAX_PRICE_IMPACT_PAISE, Math.max(MIN_PRICE_IMPACT_PAISE, scaled))
}

/**
 * The price an order of this size fills at: the mid plus its slippage when
 * buying, minus it when selling. Never outside ₹0.01–₹9.99, because a share can
 * only ever settle at ₹10 or ₹0.
 *
 * `notionalPaise` is the order's size at the mid (the amount for a buy, the
 * position's mark value for a sell). Passing the *mid* value rather than a value
 * derived from the fill price keeps this free of the circularity of sizing an
 * order at a price that depends on its own size — which is what lets the buy and
 * sell routes, and the trade preview, all derive the same price from the same
 * inputs.
 */
export function executionPricePaise(
  midPricePaise: number,
  side: PriceMoveSide,
  notionalPaise: number,
  liquidityPaise = 0,
): number {
  const impact = priceImpactPaise(notionalPaise, liquidityPaise)
  const price = side === 'buy' ? midPricePaise + impact : midPricePaise - impact
  return Math.min(SETTLEMENT_PAISE - 1, Math.max(1, price))
}

/**
 * Move the binary market price by the slippage the trade just paid, in the
 * direction of the trade. The opposing outcome is always kept at the settlement
 * complement.
 *
 * Moving by exactly the slippage charged is what makes the fill price a buy
 * establishes the *best* price the matching sell can be priced against: the sell
 * fills at that price minus its own slippage, so a round trip cannot recover what
 * it paid. Both this and `executionPricePaise` clamp to the same ₹0.01–₹9.99
 * range, so a clamped move cannot overshoot the price the order was filled at.
 */
export function calculateNextYesPrice(
  currentYesPricePaise: number,
  selectedOutcomeSide: 'yes' | 'no',
  tradeSide: PriceMoveSide,
  notionalPaise: number,
  liquidityPaise: number,
): number {
  const direction = (tradeSide === 'buy') === (selectedOutcomeSide === 'yes') ? 1 : -1
  const impact = priceImpactPaise(notionalPaise, liquidityPaise)
  return Math.min(
    SETTLEMENT_PAISE - 1,
    Math.max(1, currentYesPricePaise + direction * impact),
  )
}

/** Mark-to-market value of a holding at the current price. */
export function positionValue(milliShares: number, pricePaise: number): number {
  return calculateSellValue(milliShares, pricePaise)
}

export function pnlPercentBps(pnlPaise: number, basisPaise: number): number {
  if (basisPaise <= 0) return 0
  return Math.round((pnlPaise * 10_000) / basisPaise)
}
