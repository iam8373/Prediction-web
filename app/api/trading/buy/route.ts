import { and, eq, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'

import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { idempotencyKeys, ledgerEntries, marketOutcomes, marketPriceHistory, markets, notifications, positions, trades, transactions, wallets } from '@/lib/db/schema'
import { guardRequest, readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { calculateNextYesPrice, quoteBuy, blendAveragePrice } from '@/lib/trading/pricing'
import { getRequestKey, lockResource } from '@/lib/trading/transaction-guards'
import { tradeSchema } from '@/lib/validation/schemas'

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to place a trade' }, { status: 401 })

  try {
    await guardRequest({ request, bucket: 'trade', key: `user:${user.id}`, scope: 'trading.buy' })
    const body = (await readJsonBody(request)) as Record<string, unknown>
    const input = tradeSchema.parse({ ...body, side: 'buy' })
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

      // Quoted at the price this order will actually fill at (the mid plus its
      // own slippage), and the market is moved by that same slippage below.
      const quote = quoteBuy(input.amountPaise, outcome.pricePaise, market.liquidityPaise)
      if (quote.milliShares <= 0) throw new Error('TRADE_TOO_SMALL')

      const now = Date.now()
      const tradeId = randomUUID()
      const transactionId = randomUUID()
      const reference = `BUY-${now.toString(36).toUpperCase()}-${tradeId.slice(0, 6).toUpperCase()}`
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.userId, user.id))
        .for('update')
        .limit(1)
      if (!wallet) throw new Error('ACCOUNT_NOT_READY')

      const updatedWallet = await tx
        .update(wallets)
        .set({
          availablePaise: sql`${wallets.availablePaise} - ${input.amountPaise}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wallets.userId, user.id), sql`${wallets.availablePaise} >= ${input.amountPaise}`))
        .returning({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
      if (updatedWallet.length === 0) throw new Error('INSUFFICIENT_BALANCE')

      const [existingPosition] = await tx
        .select()
        .from(positions)
        .where(and(eq(positions.userId, user.id), eq(positions.outcomeId, input.outcomeId), eq(positions.status, 'open')))
        .for('update')
        .limit(1)
      if (existingPosition) {
        const updatedPosition = await tx
          .update(positions)
          .set({
            milliShares: existingPosition.milliShares + quote.milliShares,
            averagePricePaise: blendAveragePrice(existingPosition.milliShares, existingPosition.averagePricePaise, quote.milliShares, quote.pricePaise),
            updatedAt: now,
          })
          .where(eq(positions.id, existingPosition.id))
          .returning({ id: positions.id })
        if (updatedPosition.length === 0) throw new Error('POSITION_CONFLICT')
      } else {
        await tx.insert(positions).values({
          id: `pos_${tradeId}`,
          userId: user.id,
          marketId: input.marketId,
          outcomeId: input.outcomeId,
          milliShares: quote.milliShares,
          averagePricePaise: quote.pricePaise,
          realisedPnlPaise: 0,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        })
      }

      await tx.insert(trades).values({
        id: tradeId,
        userId: user.id,
        marketId: input.marketId,
        outcomeId: input.outcomeId,
        side: 'buy',
        milliShares: quote.milliShares,
        pricePaise: quote.pricePaise,
        amountPaise: input.amountPaise,
        createdAt: now,
      })
      const description = `Bought ${(quote.milliShares / 1000).toFixed(2)} shares of ${outcome.name} · ${market.headline}`
      await tx.insert(transactions).values({ id: transactionId, userId: user.id, reference, type: 'buy', amountPaise: -input.amountPaise, status: 'completed', description, marketId: input.marketId, createdAt: now })
      await tx.insert(ledgerEntries).values({ id: `ledger_${tradeId}`, userId: user.id, reference, type: 'buy', amountPaise: -input.amountPaise, status: 'completed', description, marketId: input.marketId, createdAt: now })
      await tx.insert(notifications).values({
        id: `notification_${tradeId}`,
        userId: user.id,
        eventKey: `trade:${tradeId}`,
        kind: 'trade',
        title: 'Buy order filled',
        description,
        href: `/markets/${market.slug}`,
        createdAt: now,
      }).onConflictDoNothing()

      const nextYesPricePaise = calculateNextYesPrice(yesOutcome.pricePaise, outcome.side as 'yes' | 'no', 'buy', input.amountPaise, market.liquidityPaise)
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
        .set({ volumePaise: sql`${markets.volumePaise} + ${input.amountPaise}`, traders: sql`${markets.traders} + 1` })
        .where(eq(markets.id, input.marketId))
        .returning({ id: markets.id })
      if (!updatedMarket) throw new Error('MARKET_CONFLICT')
      await tx.insert(marketPriceHistory).values({ id: randomUUID(), marketId: input.marketId, t: now, yesPricePaise: nextYesPricePaise })

      const result = {
        ok: true,
        transactionId,
        tradeId,
        milliShares: quote.milliShares,
        quote,
        marketPricePaise: outcome.side === 'yes' ? nextYesPricePaise : nextNoPricePaise,
        wallet: updatedWallet[0],
      }
      await tx.insert(idempotencyKeys).values({ id: randomUUID(), userId: user.id, requestKey, response: result })
      return result
    })

    return NextResponse.json(response)
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    const message = error instanceof Error ? error.message : ''
    if (error instanceof ZodError) return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid trade' }, { status: 400 })
    const errors: Record<string, { error: string; status: number }> = {
      INVALID_IDEMPOTENCY_KEY: { error: 'The idempotency key is invalid', status: 400 },
      MARKET_NOT_FOUND: { error: 'Market not found', status: 404 },
      OUTCOME_NOT_FOUND: { error: 'Outcome not found for this market', status: 404 },
      INVALID_MARKET: { error: 'This market is not configured for trading', status: 409 },
      MARKET_CLOSED: { error: 'Trading on this market is closed', status: 409 },
      TRADE_TOO_SMALL: { error: 'That amount is too small to buy a share', status: 400 },
      ACCOUNT_NOT_READY: { error: 'Your wallet is not ready yet. Try again.', status: 409 },
      INSUFFICIENT_BALANCE: { error: 'Insufficient balance. Add funds to continue.', status: 409 },
      POSITION_CONFLICT: { error: 'Your position changed. Try the trade again.', status: 409 },
      MARKET_CONFLICT: { error: 'The market changed while placing your trade. Try again.', status: 409 },
    }
    if (errors[message]) return NextResponse.json({ ok: false, error: errors[message].error }, { status: errors[message].status })
    console.error('[trading] buy failed', error)
    return NextResponse.json({ ok: false, error: 'The trade could not be completed. Try again.' }, { status: 500 })
  }
}
