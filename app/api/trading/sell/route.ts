import { and, eq, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'

import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { idempotencyKeys, ledgerEntries, marketOutcomes, marketPriceHistory, markets, notifications, positions, trades, transactions, wallets } from '@/lib/db/schema'
import { guardRequest, readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { calculateNextYesPrice, quoteSell } from '@/lib/trading/pricing'
import { getRequestKey, lockResource } from '@/lib/trading/transaction-guards'
import { sellSchema } from '@/lib/validation/schemas'

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to place a trade' }, { status: 401 })

  try {
    await guardRequest({ request, bucket: 'trade', key: `user:${user.id}`, scope: 'trading.sell' })
    const input = sellSchema.parse(await readJsonBody(request))
    const requestKey = getRequestKey(request)

    const response = await db.transaction(async (tx) => {
      await lockResource(tx, 'idempotency', user.id, requestKey)
      const [previous] = await tx
        .select({ response: idempotencyKeys.response })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.userId, user.id), eq(idempotencyKeys.requestKey, requestKey)))
        .limit(1)
      if (previous) return previous.response

      const [market] = await tx
        .select()
        .from(markets)
        .where(eq(markets.id, input.marketId))
        .for('update')
        .limit(1)
      if (!market) throw new Error('MARKET_NOT_FOUND')
      if (market.status !== 'open') throw new Error('MARKET_CLOSED')

      await lockResource(tx, 'position', user.id, input.outcomeId)
      const outcomeRows = await tx
        .select()
        .from(marketOutcomes)
        .where(eq(marketOutcomes.marketId, input.marketId))
        .for('update')
      const outcome = outcomeRows.find((row) => row.id === input.outcomeId)
      const yesOutcome = outcomeRows.find((row) => row.side === 'yes')
      const noOutcome = outcomeRows.find((row) => row.side === 'no')
      if (!outcome) throw new Error('OUTCOME_NOT_FOUND')
      if (!yesOutcome || !noOutcome) throw new Error('INVALID_MARKET')

      const [position] = await tx
        .select()
        .from(positions)
        .where(and(eq(positions.userId, user.id), eq(positions.outcomeId, input.outcomeId), eq(positions.status, 'open')))
        .for('update')
        .limit(1)
      if (!position || position.milliShares < input.milliShares) throw new Error('POSITION_TOO_SMALL')

      const quote = quoteSell(input.milliShares, outcome.pricePaise, position.averagePricePaise)
      const now = Date.now()
      const tradeId = randomUUID()
      const transactionId = randomUUID()
      const reference = `SEL-${now.toString(36).toUpperCase()}-${tradeId.slice(0, 6).toUpperCase()}`
      const remainingMilliShares = position.milliShares - input.milliShares
      const [updatedPosition] = await tx
        .update(positions)
        .set({
          milliShares: remainingMilliShares,
          realisedPnlPaise: position.realisedPnlPaise + quote.pnlPaise,
          status: remainingMilliShares === 0 ? 'closed' : 'open',
          updatedAt: now,
        })
        .where(and(eq(positions.id, position.id), eq(positions.status, 'open'), sql`${positions.milliShares} >= ${input.milliShares}`))
        .returning({ id: positions.id })
      if (!updatedPosition) throw new Error('POSITION_CONFLICT')

      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.userId, user.id))
        .for('update')
        .limit(1)
      if (!wallet) throw new Error('ACCOUNT_NOT_READY')
      const [updatedWallet] = await tx
        .update(wallets)
        .set({ availablePaise: sql`${wallets.availablePaise} + ${quote.netValuePaise}`, updatedAt: new Date() })
        .where(eq(wallets.userId, user.id))
        .returning({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
      if (!updatedWallet) throw new Error('ACCOUNT_NOT_READY')

      await tx.insert(trades).values({
        id: tradeId,
        userId: user.id,
        marketId: input.marketId,
        outcomeId: input.outcomeId,
        side: 'sell',
        milliShares: input.milliShares,
        pricePaise: outcome.pricePaise,
        amountPaise: quote.grossValuePaise,
        createdAt: now,
      })
      const description = `Sold ${(input.milliShares / 1000).toFixed(2)} shares of ${outcome.name} · ${market.headline}`
      await tx.insert(transactions).values({ id: transactionId, userId: user.id, reference, type: 'sell', amountPaise: quote.grossValuePaise, status: 'completed', description, marketId: input.marketId, createdAt: now })
      await tx.insert(ledgerEntries).values({ id: `ledger_${tradeId}`, userId: user.id, reference, type: 'sell', amountPaise: quote.grossValuePaise, status: 'completed', description, marketId: input.marketId, createdAt: now })
      await tx.insert(notifications).values({
        id: `notification_${tradeId}`,
        userId: user.id,
        eventKey: `trade:${tradeId}`,
        kind: 'trade',
        title: 'Sell order filled',
        description,
        href: `/markets/${market.slug}`,
        createdAt: now,
      }).onConflictDoNothing()

      if (quote.feePaise > 0) {
        const feeReference = `${reference}-FEE`
        const feeDescription = `Platform fee · ${market.headline}`
        await tx.insert(transactions).values({ id: `${transactionId}_fee`, userId: user.id, reference: feeReference, type: 'fee', amountPaise: -quote.feePaise, status: 'completed', description: feeDescription, marketId: input.marketId, createdAt: now })
        await tx.insert(ledgerEntries).values({ id: `ledger_${tradeId}_fee`, userId: user.id, reference: feeReference, type: 'fee', amountPaise: -quote.feePaise, status: 'completed', description: feeDescription, marketId: input.marketId, createdAt: now })
      }

      const nextYesPricePaise = calculateNextYesPrice(yesOutcome.pricePaise, outcome.side as 'yes' | 'no', 'sell', quote.grossValuePaise, market.liquidityPaise)
      const nextNoPricePaise = 1000 - nextYesPricePaise
      const [updatedYes] = await tx
        .update(marketOutcomes)
        .set({ previousPricePaise: yesOutcome.pricePaise, pricePaise: nextYesPricePaise })
        .where(eq(marketOutcomes.id, yesOutcome.id))
        .returning({ id: marketOutcomes.id })
      const [updatedNo] = await tx
        .update(marketOutcomes)
        .set({ previousPricePaise: noOutcome.pricePaise, pricePaise: nextNoPricePaise })
        .where(eq(marketOutcomes.id, noOutcome.id))
        .returning({ id: marketOutcomes.id })
      if (!updatedYes || !updatedNo) throw new Error('MARKET_CONFLICT')

      const [updatedMarket] = await tx
        .update(markets)
        .set({ volumePaise: sql`${markets.volumePaise} + ${quote.grossValuePaise}` })
        .where(eq(markets.id, input.marketId))
        .returning({ id: markets.id })
      if (!updatedMarket) throw new Error('MARKET_CONFLICT')
      await tx.insert(marketPriceHistory).values({ id: randomUUID(), marketId: input.marketId, t: now, yesPricePaise: nextYesPricePaise })

      const result = {
        ok: true,
        transactionId,
        tradeId,
        milliShares: input.milliShares,
        quote,
        marketPricePaise: outcome.side === 'yes' ? nextYesPricePaise : nextNoPricePaise,
        wallet: updatedWallet,
      }
      await tx.insert(idempotencyKeys).values({ id: randomUUID(), userId: user.id, requestKey, response: result })
      return result
    })

    return NextResponse.json(response)
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    const message = error instanceof Error ? error.message : ''
    if (error instanceof ZodError) return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid sell order' }, { status: 400 })
    const errors: Record<string, { error: string; status: number }> = {
      INVALID_IDEMPOTENCY_KEY: { error: 'The idempotency key is invalid', status: 400 },
      MARKET_NOT_FOUND: { error: 'Market not found', status: 404 },
      OUTCOME_NOT_FOUND: { error: 'Outcome not found for this market', status: 404 },
      INVALID_MARKET: { error: 'This market is not configured for trading', status: 409 },
      MARKET_CLOSED: { error: 'Trading on this market is closed', status: 409 },
      POSITION_TOO_SMALL: { error: 'You do not hold enough of this outcome', status: 409 },
      POSITION_CONFLICT: { error: 'Your position changed. Try the sell again.', status: 409 },
      ACCOUNT_NOT_READY: { error: 'Your wallet is not ready yet. Try again.', status: 409 },
      MARKET_CONFLICT: { error: 'The market changed while selling. Try again.', status: 409 },
    }
    if (errors[message]) return NextResponse.json({ ok: false, error: errors[message].error }, { status: errors[message].status })
    console.error('[v0] sell failed', error)
    return NextResponse.json({ ok: false, error: 'The sell order could not be completed. Try again.' }, { status: 500 })
  }
}
