/**
 * Pricing engine.
 *
 * This module is deliberately free of React and of any data-access code so the
 * current fixed-price model can be swapped for an order book, an AMM, an
 * external exchange or on-chain settlement without touching the UI.
 *
 * Model (v1 — "static book"):
 *   - A binary market has two outcomes whose per-share prices sum to ₹10.
 *   - Buying N shares of an outcome costs N × price.
 *   - A winning share settles at ₹10, a losing share settles at ₹0.
 *   - Platform fee is charged on winnings only.
 */

import { SETTLEMENT_PAISE, SHARE_UNIT } from '@/lib/money'
import type { Market, MarketOutcome } from '@/types'

export const FEE_BPS = 200 // 2% on winnings
export const MIN_TRADE_PAISE = 100 // ₹1
export const MAX_TRADE_PAISE = 10_000_00 // ₹10,000 per order

export interface BuyQuote {
  amountPaise: number
  pricePaise: number
  milliShares: number
  grossPayoutPaise: number
  feePaise: number
  netPayoutPaise: number
  profitPaise: number
  multiplierBps: number
}

export interface SellQuote {
  milliShares: number
  pricePaise: number
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

export function quoteBuy(amountPaise: number, pricePaise: number): BuyQuote {
  const milliShares = calculateShares(amountPaise, pricePaise)
  const grossPayoutPaise = calculatePotentialPayout(milliShares)
  const winnings = Math.max(0, grossPayoutPaise - amountPaise)
  const feePaise = calculateFees(winnings)
  const netPayoutPaise = grossPayoutPaise - feePaise
  return {
    amountPaise,
    pricePaise,
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
  pricePaise: number,
  averagePricePaise: number,
): SellQuote {
  const grossValuePaise = calculateSellValue(milliShares, pricePaise)
  const basis = costBasis(milliShares, averagePricePaise)
  const feePaise = calculateFees(Math.max(0, grossValuePaise - basis))
  const netValuePaise = grossValuePaise - feePaise
  return {
    milliShares,
    pricePaise,
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

/**
 * Move the binary market price using the existing fixed-price model's liquidity
 * as depth. The selected outcome moves in the direction of the trade and the
 * opposing outcome is always kept at the settlement complement.
 */
export function calculateNextYesPrice(
  currentYesPricePaise: number,
  selectedOutcomeSide: 'yes' | 'no',
  tradeSide: PriceMoveSide,
  notionalPaise: number,
  liquidityPaise: number,
): number {
  const direction = (tradeSide === 'buy') === (selectedOutcomeSide === 'yes') ? 1 : -1
  const depth = Math.max(liquidityPaise, SETTLEMENT_PAISE * 100)
  const impact = Math.min(60, Math.max(1, Math.round((Math.max(0, notionalPaise) * 100) / depth)))
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
