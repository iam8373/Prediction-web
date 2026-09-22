import 'server-only'

import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db } from '@/lib/db'
import {
  categories,
  ledgerEntries,
  marketOutcomes,
  marketPriceHistory,
  markets,
  notifications,
  positions,
  transactions,
  wallets,
} from '@/lib/db/schema'
import { costBasis } from '@/lib/trading/pricing'
import { lockResource } from '@/lib/trading/transaction-guards'

/**
 * Retirement of the crypto category.
 *
 * Predik does not list crypto markets, so the category, its demo catalogue and
 * every reference to it were removed. A deployment that already ran an older
 * build still has those rows in its database, and hiding them from navigation
 * would leave a live market that nobody can see but anyone with a bookmark can
 * still trade — so this removes them for real.
 *
 * Money is settled first, and settling means *refunding*, not resolving: the
 * market was withdrawn by the operator rather than decided by an outcome, so
 * every open position is returned to its holder at exactly its cost basis. No
 * fee is charged and no position is paid a profit or a loss. That is the
 * conservative direction for a withdrawal the user did not choose, and it keeps
 * the wallet, `transaction` and `ledger_entry` rows in agreement: each refund is
 * written to both tables with one reference.
 *
 * The step is idempotent by construction. It only touches markets whose
 * `category_id` is still `crypto`, and each market is refunded and deleted in a
 * single transaction, so a run that is interrupted (or races a second instance)
 * either settles a market completely or leaves it untouched for the next run.
 * Wallet balances are credited with an SQL-side `+=`, under the same
 * `pg_advisory_xact_lock` the settlement path uses, so it cannot lose an update
 * against a concurrent trade.
 *
 * Historical `position` and `trade` rows are deliberately left in place: they
 * are the record of what those users did, and the portfolio view already skips a
 * position whose market no longer exists.
 */
const RETIRED_CATEGORY = 'crypto'

export interface CryptoRetirementResult {
  /** Markets refunded and deleted by this run. Zero on every run after the first. */
  retiredMarkets: number
  refundedPositions: number
  refundedPaise: number
}

export async function retireCryptoMarkets(): Promise<CryptoRetirementResult> {
  const doomed = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.categoryId, RETIRED_CATEGORY))
  const [legacyCategory] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, RETIRED_CATEGORY))
    .limit(1)

  // Read-only when there is nothing to retire, which is every start after the
  // first: a deployment that is done with this must not write on boot.
  if (doomed.length === 0 && !legacyCategory) {
    return { retiredMarkets: 0, refundedPositions: 0, refundedPaise: 0 }
  }

  let refundedPositions = 0
  let refundedPaise = 0

  for (const target of doomed) {
    const settled = await db.transaction(async (tx) => {
      await lockResource(tx, 'market', target.id)
      const [market] = await tx
        .select({ id: markets.id, headline: markets.headline, categoryId: markets.categoryId })
        .from(markets)
        .where(eq(markets.id, target.id))
        .for('update')
        .limit(1)
      // Another instance may have retired it while this one waited for the lock.
      if (!market || market.categoryId !== RETIRED_CATEGORY) return { positions: 0, paise: 0 }

      const openPositions = await tx
        .select()
        .from(positions)
        .where(and(eq(positions.marketId, target.id), eq(positions.status, 'open')))
        .for('update')

      const now = Date.now()
      let paise = 0

      for (const position of openPositions) {
        const refundPaise = costBasis(position.milliShares, position.averagePricePaise)
        const updated = await tx
          .update(positions)
          .set({ status: 'settled', realisedPnlPaise: 0, updatedAt: now })
          .where(and(eq(positions.id, position.id), eq(positions.status, 'open')))
          .returning({ id: positions.id })
        // Someone traded it between the read and the write: leave the market in
        // place rather than refunding a position that has just changed.
        if (!updated[0]) throw new Error('RETIREMENT_CONFLICT')

        if (refundPaise > 0) {
          const wallet = await tx
            .update(wallets)
            .set({ availablePaise: sql`${wallets.availablePaise} + ${refundPaise}`, updatedAt: new Date() })
            .where(eq(wallets.userId, position.userId))
            .returning({ userId: wallets.userId })
          if (!wallet[0]) throw new Error('ACCOUNT_NOT_READY')

          const reference = `VOID-${target.id.slice(0, 12).toUpperCase()}-${position.id.slice(-8).toUpperCase()}`
          const description = `Market withdrawn — stake refunded · ${market.headline}`
          const transactionId = randomUUID()
          await tx.insert(transactions).values({
            id: transactionId,
            userId: position.userId,
            reference,
            type: 'refund',
            amountPaise: refundPaise,
            status: 'completed',
            description,
            marketId: market.id,
            createdAt: now,
          })
          await tx.insert(ledgerEntries).values({
            id: `ledger_${transactionId}`,
            userId: position.userId,
            reference,
            type: 'refund',
            amountPaise: refundPaise,
            status: 'completed',
            description,
            marketId: market.id,
            createdAt: now,
          })
          paise += refundPaise
        }

        await tx
          .insert(notifications)
          .values({
            id: `notification_retire_${position.id}`,
            userId: position.userId,
            eventKey: `market.retired:${market.id}:${position.id}`,
            kind: 'settlement',
            title: 'Market withdrawn — stake refunded',
            description: `${market.headline} was withdrawn. Your ${position.milliShares / 1000} shares were refunded in full.`,
            href: '/wallet',
            createdAt: now,
          })
          .onConflictDoNothing()
      }

      // Only rows that cannot outlive the market are deleted. Trades, positions
      // and ledger entries stay: they are the financial record.
      await tx.delete(marketPriceHistory).where(eq(marketPriceHistory.marketId, market.id))
      await tx.delete(marketOutcomes).where(eq(marketOutcomes.marketId, market.id))
      await tx.delete(markets).where(eq(markets.id, market.id))

      return { positions: openPositions.length, paise }
    })

    refundedPositions += settled.positions
    refundedPaise += settled.paise
  }

  // The category row goes even if no market used it, so the UI can never offer a
  // category that resolves to nothing.
  if (legacyCategory) await db.delete(categories).where(eq(categories.id, RETIRED_CATEGORY))

  if (doomed.length > 0) {
    // Withdrawing a live market refunds real balances, so it is attributable
    // even though no admin clicked anything.
    await recordAudit({
      actorRole: 'system',
      action: AUDIT_ACTIONS.marketRetired,
      entityType: 'category',
      entityId: RETIRED_CATEGORY,
      summary: `Retired the ${RETIRED_CATEGORY} category: ${doomed.length} market(s) removed, ${refundedPositions} position(s) refunded`,
      metadata: { markets: doomed.map((market) => market.id), refundedPositions, refundedPaise },
    })
  }

  return { retiredMarkets: doomed.length, refundedPositions, refundedPaise }
}

