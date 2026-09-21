import { costBasis, pnlPercentBps, positionValue } from '@/lib/trading/pricing'
import type { Market, MarketOutcome, Position } from '@/types'

export function useEffectiveMarket(market: Market): Market {
  return market
}

export interface EnrichedPosition {
  position: Position
  market: Market
  outcome: MarketOutcome
  costBasisPaise: number
  currentValuePaise: number
  unrealisedPnlPaise: number
  pnlBps: number
  resolvedWon?: boolean
}

export function enrichPositions(positions: Position[], marketCatalog: Market[]): EnrichedPosition[] {
  const rows: EnrichedPosition[] = []
  for (const position of positions) {
    const market = marketCatalog.find((item) => item.id === position.marketId)
    if (!market) continue
    const outcome = market.outcomes.find((item) => item.id === position.outcomeId)
    if (!outcome) continue
    const basis = costBasis(position.milliShares, position.averagePricePaise)
    const settled = position.status === 'settled'
    const value = settled
      ? market.resolvedOutcomeId === outcome.id
        ? position.milliShares
        : 0
      : positionValue(position.milliShares, outcome.pricePaise)
    const unrealised = settled ? 0 : value - basis
    rows.push({
      position,
      market,
      outcome,
      costBasisPaise: basis,
      currentValuePaise: value,
      unrealisedPnlPaise: unrealised,
      pnlBps: pnlPercentBps(settled ? position.realisedPnlPaise : unrealised, basis),
      resolvedWon: settled ? market.resolvedOutcomeId === outcome.id : undefined,
    })
  }
  return rows
}

export interface PortfolioSummary {
  investedPaise: number
  positionsValuePaise: number
  unrealisedPnlPaise: number
  realisedPnlPaise: number
  totalValuePaise: number
  openCount: number
  settledCount: number
}

export function summarisePortfolio(
  rows: EnrichedPosition[],
  availablePaise: number,
): PortfolioSummary {
  const open = rows.filter((r) => r.position.status === 'open')
  const settled = rows.filter((r) => r.position.status !== 'open')
  const invested = open.reduce((sum, r) => sum + r.costBasisPaise, 0)
  const value = open.reduce((sum, r) => sum + r.currentValuePaise, 0)
  const realised = rows.reduce((sum, r) => sum + r.position.realisedPnlPaise, 0)
  return {
    investedPaise: invested,
    positionsValuePaise: value,
    unrealisedPnlPaise: value - invested,
    realisedPnlPaise: realised,
    totalValuePaise: availablePaise + value,
    openCount: open.length,
    settledCount: settled.length,
  }
}
