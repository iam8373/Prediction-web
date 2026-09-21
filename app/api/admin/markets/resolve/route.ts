import { and, eq, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db } from '@/lib/db'
import { ledgerEntries, marketOutcomes, markets, notifications, positions, transactions, wallets } from '@/lib/db/schema'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { calculateFees, calculatePotentialPayout, costBasis } from '@/lib/trading/pricing'
import { lockResource } from '@/lib/trading/transaction-guards'

const schema = z.object({
  marketId: z.string().trim().min(1).max(120),
  outcomeId: z.string().trim().min(1).max(120),
})

export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminMarket', scope: 'admin.markets.resolve' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const { marketId, outcomeId } = schema.parse(await readJsonBody(request))
    const result = await db.transaction(async (tx) => {
      await lockResource(tx, 'market', marketId)
      const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update').limit(1)
      const [outcome] = await tx.select().from(marketOutcomes).where(and(eq(marketOutcomes.id, outcomeId), eq(marketOutcomes.marketId, marketId))).limit(1)
      if (!market || !outcome) throw new Error('UNKNOWN_MARKET')
      if (market.status === 'resolved') throw new Error('ALREADY_RESOLVED')

      const openPositions = await tx
        .select()
        .from(positions)
        .where(and(eq(positions.marketId, marketId), eq(positions.status, 'open')))
        .for('update')
      const now = Date.now()
      for (const position of openPositions) {
        const basis = costBasis(position.milliShares, position.averagePricePaise)
        const isWinner = position.outcomeId === outcomeId
        const gross = isWinner ? calculatePotentialPayout(position.milliShares) : 0
        const fee = isWinner ? calculateFees(Math.max(0, gross - basis)) : 0
        const netPayout = gross - fee
        const updatedPosition = await tx
          .update(positions)
          .set({ status: 'settled', realisedPnlPaise: isWinner ? netPayout - basis : -basis, updatedAt: now })
          .where(and(eq(positions.id, position.id), eq(positions.status, 'open')))
          .returning({ id: positions.id })
        if (!updatedPosition[0]) throw new Error('SETTLEMENT_CONFLICT')

        if (gross > 0) {
          const [wallet] = await tx
            .update(wallets)
            .set({ availablePaise: sql`${wallets.availablePaise} + ${netPayout}`, updatedAt: new Date() })
            .where(eq(wallets.userId, position.userId))
            .returning({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
          if (!wallet) throw new Error('ACCOUNT_NOT_READY')

          const reference = `SET-${marketId.slice(0, 8).toUpperCase()}-${position.id.slice(-8).toUpperCase()}`
          const description = `Settlement payout · ${market.headline}`
          const payoutId = randomUUID()
          await tx.insert(transactions).values({ id: payoutId, userId: position.userId, reference, type: 'payout', amountPaise: gross, status: 'completed', description, marketId, createdAt: now })
          await tx.insert(ledgerEntries).values({ id: `ledger_${payoutId}`, userId: position.userId, reference, type: 'payout', amountPaise: gross, status: 'completed', description, marketId, createdAt: now })
          if (fee > 0) {
            const feeReference = `${reference}-FEE`
            const feeDescription = `Platform fee on settlement · ${market.headline}`
            const feeId = randomUUID()
            await tx.insert(transactions).values({ id: feeId, userId: position.userId, reference: feeReference, type: 'fee', amountPaise: -fee, status: 'completed', description: feeDescription, marketId, createdAt: now })
            await tx.insert(ledgerEntries).values({ id: `ledger_${feeId}`, userId: position.userId, reference: feeReference, type: 'fee', amountPaise: -fee, status: 'completed', description: feeDescription, marketId, createdAt: now })
          }
        }

        await tx.insert(notifications).values({
          id: `notification_settlement_${position.id}`,
          userId: position.userId,
          eventKey: `settlement:${marketId}:${position.id}`,
          kind: 'settlement',
          title: isWinner ? 'Settlement payout credited' : 'Market resolved',
          description: isWinner
            ? `Your ${outcome.name} position settled · ${market.headline}`
            : `${market.headline} resolved as ${outcome.name}`,
          href: `/markets/${market.slug}`,
          createdAt: now,
        }).onConflictDoNothing()
      }

      const [resolvedMarket] = await tx
        .update(markets)
        .set({ status: 'resolved', resolvedOutcomeId: outcomeId })
        .where(and(eq(markets.id, marketId), eq(markets.status, market.status)))
        .returning({ id: markets.id })
      if (!resolvedMarket) throw new Error('SETTLEMENT_CONFLICT')
      return { ok: true, resolvedOutcomes: openPositions.length }
    })

    // Resolution pays winners and writes ledger entries: always attributable.
    await recordAudit({
      actorRole: 'admin',
      actorUserId: admin.id,
      action: AUDIT_ACTIONS.marketResolved,
      entityType: 'market',
      entityId: marketId,
      summary: `Market resolved to outcome ${outcomeId} (${result.resolvedOutcomes} open positions settled)`,
      metadata: { outcomeId, settledPositions: result.resolvedOutcomes },
    })

    return NextResponse.json(result)
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    const message = error instanceof Error ? error.message : ''
    if (error instanceof z.ZodError) return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid resolution' }, { status: 400 })
    if (message === 'UNKNOWN_MARKET') return NextResponse.json({ ok: false, error: 'Unknown market or outcome' }, { status: 404 })
    if (message === 'ALREADY_RESOLVED' || message === 'SETTLEMENT_CONFLICT') return NextResponse.json({ ok: false, error: 'Market has already changed. Refresh and try again.' }, { status: 409 })
    if (message === 'ACCOUNT_NOT_READY') return NextResponse.json({ ok: false, error: 'A trader wallet is not ready, so settlement was rolled back.' }, { status: 409 })
    console.error('[v0] market resolution failed', error)
    return NextResponse.json({ ok: false, error: 'The market could not be resolved' }, { status: 500 })
  }
}
