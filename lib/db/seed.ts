import 'server-only'

import { eq } from 'drizzle-orm'

import { categories as categorySeed } from '@/lib/data/categories'
import { demoMarkets } from '@/lib/data/markets'
import { db } from '@/lib/db'
import { categories, marketOutcomes, marketPriceHistory, markets, positions, referrals, transactions, wallets } from '@/lib/db/schema'

let seedPromise: Promise<void> | null = null

function referralCode(userId: string) {
  const normalized = userId.replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase()
  return `PREDIK${normalized}`
}

async function ensurePersonalReferral(userId: string, createdAt = Date.now()) {
  await db.insert(referrals).values({
    id: `referral_${userId}`,
    referrerUserId: userId,
    code: referralCode(userId),
    status: 'pending',
    rewardPaise: 0,
    createdAt,
  }).onConflictDoNothing()
}

export function ensureDemoCatalog() {
  seedPromise ??= seedIfEmpty().catch((error) => {
    seedPromise = null
    throw error
  })
  return seedPromise
}

export async function ensureUserAccount(userId: string, phone: string) {
  const existing = await db.select({ userId: wallets.userId }).from(wallets).where(eq(wallets.userId, userId)).limit(1)
  if (existing.length > 0) {
    await ensurePersonalReferral(userId)
    return
  }

  const now = Date.now()
  const isDemo = process.env.NODE_ENV !== 'production' && phone === '9876543210'
  await db.transaction(async (tx) => {
    await tx.insert(wallets).values({
      userId,
      availablePaise: isDemo ? 245_075 : 0,
      lockedPaise: isDemo ? 39_400 : 0,
      bonusPaise: isDemo ? 10_000 : 0,
    }).onConflictDoNothing()

    await tx.insert(referrals).values({
      id: `referral_${userId}`,
      referrerUserId: userId,
      code: referralCode(userId),
      status: 'pending',
      rewardPaise: 0,
      createdAt: now,
    }).onConflictDoNothing()

    if (!isDemo) return

    await tx.insert(positions).values([
      { id: 'pos_eth', userId, marketId: 'eth-5000-newyear', outcomeId: 'eth-5000-newyear:yes', milliShares: 64_000, averagePricePaise: 520, realisedPnlPaise: 0, status: 'open', createdAt: now - 9 * 86_400_000, updatedAt: now - 2 * 86_400_000 },
      { id: 'pos_ndt', userId, marketId: 'ndt-wdl-t20', outcomeId: 'ndt-wdl-t20:no', milliShares: 30_000, averagePricePaise: 505, realisedPnlPaise: 0, status: 'open', createdAt: now - 2 * 86_400_000, updatedAt: now - 86_400_000 },
      { id: 'pos_nifty', userId, marketId: 'nifty-26k', outcomeId: 'nifty-26k:yes', milliShares: 22_000, averagePricePaise: 402, realisedPnlPaise: 0, status: 'open', createdAt: now - 5 * 86_400_000, updatedAt: now - 3 * 86_400_000 },
      { id: 'pos_asia', userId, marketId: 'asia-cup-final-resolved', outcomeId: 'asia-cup-final-resolved:yes', milliShares: 40_000, averagePricePaise: 690, realisedPnlPaise: 116_800, status: 'settled', createdAt: now - 12 * 86_400_000, updatedAt: now - 2 * 86_400_000 },
      { id: 'pos_btc70', userId, marketId: 'btc-70k-resolved', outcomeId: 'btc-70k-resolved:yes', milliShares: 15_000, averagePricePaise: 380, realisedPnlPaise: -57_000, status: 'settled', createdAt: now - 15 * 86_400_000, updatedAt: now - 4 * 86_400_000 },
    ]).onConflictDoNothing()

    const seededTransactions = [
      ['seed-deposit', 'DEP-DEMO-1', 'deposit', 500_000, 'UPI deposit'],
      ['seed-buy-eth', 'BUY-DEMO-1', 'buy', -33_280, 'Bought 64 shares of Yes · ETH hits $5,000'],
      ['seed-buy-ndt', 'BUY-DEMO-2', 'buy', -15_150, 'Bought 30 shares of WDL · NDT vs WDL'],
      ['seed-buy-nifty', 'BUY-DEMO-3', 'buy', -8_844, 'Bought 22 shares of Yes · Nifty 50 above 26,000'],
      ['seed-payout-asia', 'PAY-DEMO-1', 'payout', 400_000, 'Settlement · IND vs SL final'],
      ['seed-fee-asia', 'FEE-DEMO-1', 'fee', -8_320, 'Platform fee on settlement'],
      ['seed-buy-btc', 'BUY-DEMO-4', 'buy', -57_000, 'Bought 15 shares of Yes · BTC above $70,000'],
      ['seed-withdrawal', 'WDL-DEMO-1', 'withdrawal', -150_000, 'Withdrawal to UPI'],
      ['seed-bonus', 'BON-DEMO-1', 'bonus', 10_000, 'Welcome bonus'],
    ] as const

    await tx.insert(transactions).values(seededTransactions.map(([id, reference, type, amountPaise, description], index) => ({
      id,
      userId,
      reference,
      type,
      amountPaise,
      status: type === 'withdrawal' ? 'pending' : 'completed',
      description,
      marketId: id.includes('eth') ? 'eth-5000-newyear' : id.includes('ndt') ? 'ndt-wdl-t20' : id.includes('nifty') ? 'nifty-26k' : id.includes('asia') ? 'asia-cup-final-resolved' : id.includes('btc') ? 'btc-70k-resolved' : null,
      createdAt: now - (seededTransactions.length - index) * 36 * 3_600_000,
    }))).onConflictDoNothing()
  })
}

async function seedIfEmpty() {
  const existing = await db.select({ id: markets.id }).from(markets).limit(1)
  if (existing.length > 0) return

  await db.transaction(async (tx) => {
    await tx.insert(categories).values(categorySeed).onConflictDoNothing()

    for (const market of demoMarkets) {
      await tx.insert(markets).values({
        id: market.id,
        slug: market.slug,
        question: market.question,
        headline: market.headline,
        description: market.description,
        resolutionCriteria: market.resolutionCriteria,
        source: market.source,
        categoryId: market.categoryId,
        kind: market.kind,
        status: market.status,
        league: market.league ?? null,
        emblem: market.emblem,
        live: market.live,
        featured: market.featured,
        bonus: market.bonus,
        createdAt: market.createdAt,
        opensAt: market.opensAt,
        closesAt: market.closesAt,
        resolvesAt: market.resolvesAt,
        resolvedOutcomeId: market.resolvedOutcomeId ?? null,
        volumePaise: market.volumePaise,
        liquidityPaise: market.liquidityPaise,
        traders: market.traders,
      }).onConflictDoNothing()

      await tx.insert(marketOutcomes).values(
        market.outcomes.map((outcome) => ({
          id: outcome.id,
          marketId: outcome.marketId,
          name: outcome.name,
          side: outcome.side,
          pricePaise: outcome.pricePaise,
          previousPricePaise: outcome.previousPricePaise,
        })),
      ).onConflictDoNothing()

      await tx.insert(marketPriceHistory).values(
        market.priceHistory.map((point, index) => ({
          id: `${market.id}:${point.t}:${index}`,
          marketId: market.id,
          t: point.t,
          yesPricePaise: point.yes,
        })),
      ).onConflictDoNothing()
    }
  })
}

