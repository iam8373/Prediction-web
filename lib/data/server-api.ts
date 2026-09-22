import 'server-only'

import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm'

import { ensureDemoCatalog } from '@/lib/db/seed'
import { db } from '@/lib/db'
import {
  categories,
  marketOutcomes,
  marketPriceHistory,
  markets,
  notifications,
  paymentAccounts,
  paymentIntents,
  paymentWebhookEvents,
  positions,
  referrals,
  trades,
  transactions,
  users,
  wallets,
  watchlists,
} from '@/lib/db/schema'
import { ensurePaymentSchema } from '@/lib/db/payment-schema'
import { publicPaymentConfig } from '@/lib/payments/config'
import { safeCheckoutUrl } from '@/lib/security/url-safety'
import type { PaymentDirection, PaymentStatus, ReconciliationStatus } from '@/lib/payments/state-machine'
import { cache } from 'react'

import { DEMO_NOW } from '@/lib/data/demo-config'
import { syncProviderMarkets } from '@/lib/data/provider-markets'
import { timed } from '@/lib/observability/timing'
import { sortLabels } from '@/lib/data/market-filters'
import type {
  AdminTransaction,
  Market,
  MarketFilters,
  Notification,
  Paginated,
  PaymentModeSummary,
  PaymentRecord,
  PaymentWebhookEventSummary,
  Position,
  ProfileStats,
  ReferralSummary,
  SortKey,
  Trade,
  Transaction,
  Wallet,
} from '@/types'

export { sortLabels }

/**
 * Makes the catalogue ready to read: the seeded demo markets, plus whatever the
 * configured providers currently list.
 *
 * The provider step is optional by design. It is memoized in
 * `syncProviderMarkets` (one refresh per ten minutes per process), it returns
 * immediately when no provider is configured, and a failure is logged rather
 * than thrown — a provider problem must never stop a market page rendering.
 */
async function ensureCatalog() {
  await ensureDemoCatalog()
  try {
    await syncProviderMarkets()
  } catch (error) {
    console.error('[data] provider market sync failed:', error)
  }
}

function rowToMarket(
  row: typeof markets.$inferSelect,
  outcomes: Array<typeof marketOutcomes.$inferSelect>,
  history: Array<typeof marketPriceHistory.$inferSelect>,
): Market {
  return {
    id: row.id,
    slug: row.slug,
    question: row.question,
    headline: row.headline,
    description: row.description,
    resolutionCriteria: row.resolutionCriteria,
    source: row.source,
    categoryId: row.categoryId,
    kind: row.kind as Market['kind'],
    status: row.status as Market['status'],
    league: row.league ?? undefined,
    emblem: row.emblem,
    videoId: row.videoId ?? undefined,
    live: row.live,
    featured: row.featured,
    bonus: row.bonus,
    createdAt: row.createdAt,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    resolvesAt: row.resolvesAt,
    resolvedOutcomeId: row.resolvedOutcomeId ?? undefined,
    volumePaise: row.volumePaise,
    liquidityPaise: row.liquidityPaise,
    traders: row.traders,
    outcomes: outcomes.map((outcome) => ({
      id: outcome.id,
      marketId: outcome.marketId,
      name: outcome.name,
      side: outcome.side as 'yes' | 'no',
      pricePaise: outcome.pricePaise,
      previousPricePaise: outcome.previousPricePaise,
    })),
    priceHistory: history
      .sort((a, b) => a.t - b.t)
      .map((point) => ({ t: point.t, yes: point.yesPricePaise })),
  }
}

async function hydrateMarkets(rows: Array<typeof markets.$inferSelect>) {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const [outcomeRows, historyRows] = await Promise.all([
    db.select().from(marketOutcomes).where(inArray(marketOutcomes.marketId, ids)),
    db.select().from(marketPriceHistory).where(inArray(marketPriceHistory.marketId, ids)),
  ])
  return rows.map((row) => rowToMarket(
    row,
    outcomeRows.filter((outcome) => outcome.marketId === row.id),
    historyRows.filter((point) => point.marketId === row.id),
  ))
}

export async function getAllMarkets() {
  return timed('markets.all', loadAllMarkets)
}

async function loadAllMarkets() {
  await ensureCatalog()
  const rows = await db.select().from(markets)
  return hydrateMarkets(rows)
}

/**
 * One market by id or slug.
 *
 * Wrapped in React's `cache` because a market page reads the same market twice
 * in one render — once for `generateMetadata` and once for the page itself — and
 * the second read would otherwise be a second round trip to the database.
 */
export const getMarket = cache(async (idOrSlug: string) =>
  timed('market.detail', () => loadMarket(idOrSlug)),
)

async function loadMarket(idOrSlug: string) {
  await ensureCatalog()
  const rows = await db.select().from(markets).where(or(eq(markets.id, idOrSlug), eq(markets.slug, idOrSlug))).limit(1)
  const result = await hydrateMarkets(rows)
  return result[0]
}

function matchesQuery(market: Market, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return market.question.toLowerCase().includes(q) ||
    market.headline.toLowerCase().includes(q) ||
    market.categoryId.toLowerCase().includes(q) ||
    (market.league?.toLowerCase().includes(q) ?? false) ||
    market.description.toLowerCase().includes(q)
}

function trendingScore(market: Market) {
  const movement = Math.abs(market.outcomes[0].pricePaise - market.outcomes[0].previousPricePaise)
  const recency = Math.max(0, 1 - (DEMO_NOW - market.createdAt) / (30 * 86_400_000))
  return market.traders * 1.4 + movement * 220 + recency * 6000 + (market.live ? 9000 : 0)
}

const sorters: Record<SortKey, (a: Market, b: Market) => number> = {
  trending: (a, b) => trendingScore(b) - trendingScore(a),
  volume: (a, b) => b.volumePaise - a.volumePaise,
  newest: (a, b) => b.createdAt - a.createdAt,
  closing: (a, b) => a.closesAt - b.closesAt,
  'probability-high': (a, b) => b.outcomes[0].pricePaise - a.outcomes[0].pricePaise,
  'probability-low': (a, b) => a.outcomes[0].pricePaise - b.outcomes[0].pricePaise,
}

export async function queryMarkets(filters: MarketFilters = {}): Promise<Paginated<Market>> {
  return timed('markets.query', () => loadMarketPage(filters))
}

async function loadMarketPage(filters: MarketFilters): Promise<Paginated<Market>> {
  const { category, query = '', sort = 'trending', status = 'live', page = 1, perPage = 12 } = filters
  const categoryId = category && category !== 'all'
    ? (await db
      .select({ id: categories.id })
      .from(categories)
      .where(or(eq(categories.id, category), eq(categories.slug, category)))
      .limit(1))[0]?.id
    : undefined
  let rows = await getAllMarkets()
  rows = rows.filter((market) => {
    if (status === 'live' && market.status === 'resolved') return false
    if (status === 'resolved' && market.status !== 'resolved') return false
    if (category && category !== 'all' && market.categoryId !== categoryId) return false
    return matchesQuery(market, query)
  })
  rows.sort(sorters[sort] ?? sorters.trending)
  const start = (page - 1) * perPage
  return { items: rows.slice(start, start + perPage), total: rows.length, page, perPage, hasMore: start + perPage < rows.length }
}

export async function featuredMarkets(limit = 4) {
  const result = await getAllMarkets()
  return result.filter((market) => market.featured && market.status === 'open').slice(0, limit)
}

export async function liveMarkets(limit = 8) {
  const result = await getAllMarkets()
  return result.filter((market) => market.live).slice(0, limit)
}

export async function closingSoonMarkets(limit = 6) {
  const result = await getAllMarkets()
  return result.filter((market) => market.status === 'open' && market.closesAt > Date.now()).sort((a, b) => a.closesAt - b.closesAt).slice(0, limit)
}

export async function newestMarkets(limit = 6) {
  const result = await getAllMarkets()
  return result.filter((market) => market.status === 'open').sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export async function highestVolumeMarkets(limit = 6) {
  const result = await getAllMarkets()
  return result.filter((market) => market.status === 'open').sort((a, b) => b.volumePaise - a.volumePaise).slice(0, limit)
}

export async function resolvedMarkets(limit = 12) {
  const result = await getAllMarkets()
  return result.filter((market) => market.status === 'resolved').slice(0, limit)
}

export async function platformStats() {
  return timed('stats.platform', loadPlatformStats)
}

async function loadPlatformStats() {
  await ensureCatalog()
  const [result] = await db.select({
    volumePaise: sql<number>`coalesce(sum(${markets.volumePaise}), 0)`,
    openMarkets: sql<number>`count(*) filter (where ${markets.status} = 'open')`,
    resolvedMarkets: sql<number>`count(*) filter (where ${markets.status} = 'resolved')`,
    traders: sql<number>`coalesce(sum(${markets.traders}), 0)`,
  }).from(markets)
  return {
    volumePaise: Number(result?.volumePaise ?? 0),
    openMarkets: Number(result?.openMarkets ?? 0),
    resolvedMarkets: Number(result?.resolvedMarkets ?? 0),
    traders: Number(result?.traders ?? 0),
    feesPaise: Math.round(Number(result?.volumePaise ?? 0) * 0.02),
  }
}

export async function recentTradesFromDb(market: Market, limit = 8): Promise<Trade[]> {
  const rows = await db
    .select({ trade: trades, traderName: users.name })
    .from(trades)
    .leftJoin(users, eq(trades.userId, users.id))
    .where(eq(trades.marketId, market.id))
    .orderBy(desc(trades.createdAt))
    .limit(limit)

  return rows.map(({ trade, traderName }) => ({
    id: trade.id,
    marketId: trade.marketId,
    outcomeId: trade.outcomeId,
    side: trade.side as 'buy' | 'sell',
    milliShares: trade.milliShares,
    pricePaise: trade.pricePaise,
    amountPaise: trade.amountPaise,
    createdAt: trade.createdAt,
    trader: traderName ?? 'Trader',
  }))
}

export interface LeaderboardRow {
  rank: number
  name: string
  pnlPaise: number
  volumePaise: number
  accuracyBps: number
}

export async function leaderboardFromDb(limit = 10): Promise<LeaderboardRow[]> {
  return timed('leaderboard', () => loadLeaderboard(limit))
}

/** The most expensive read in the app: it aggregates every trader's positions. */
async function loadLeaderboard(limit: number): Promise<LeaderboardRow[]> {
  await ensureCatalog()
  const [userRows, tradeRows, positionRows] = await Promise.all([
    db.select({ id: users.id, name: users.name }).from(users),
    db.select({
      userId: trades.userId,
      volumePaise: sql<number>`coalesce(sum(abs(${trades.amountPaise})), 0)`,
    }).from(trades).groupBy(trades.userId),
    db.select({
      userId: positions.userId,
      pnlPaise: sql<number>`coalesce(sum(${positions.realisedPnlPaise}), 0)`,
      settledCount: sql<number>`count(*) filter (where ${positions.status} = 'settled')`,
      wins: sql<number>`count(*) filter (where ${positions.status} = 'settled' and ${positions.realisedPnlPaise} > 0)`,
    }).from(positions).groupBy(positions.userId),
  ])
  const volumeByUser = new Map(tradeRows.map((row) => [row.userId, Number(row.volumePaise)]))
  const positionByUser = new Map(positionRows.map((row) => [row.userId, {
    pnlPaise: Number(row.pnlPaise),
    settledCount: Number(row.settledCount),
    wins: Number(row.wins),
  }]))

  return userRows
    .map((user) => {
      const position = positionByUser.get(user.id)
      const volumePaise = volumeByUser.get(user.id) ?? 0
      const pnlPaise = position?.pnlPaise ?? 0
      return {
        rank: 0,
        name: user.name,
        pnlPaise,
        volumePaise,
        accuracyBps: position?.settledCount ? Math.round((position.wins / position.settledCount) * 10_000) : 0,
      }
    })
    .filter((row) => row.volumePaise > 0 || row.pnlPaise !== 0)
    .sort((a, b) => b.pnlPaise - a.pnlPaise || b.volumePaise - a.volumePaise)
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1 }))
}

export async function getCategories() {
  await ensureCatalog()
  return db.select().from(categories)
}

export async function getCategorySummaries() {
  await ensureCatalog()
  return db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      icon: categories.icon,
      accent: categories.accent,
      marketCount: sql<number>`count(${markets.id})`,
    })
    .from(categories)
    .leftJoin(markets, eq(markets.categoryId, categories.id))
    .groupBy(categories.id, categories.name, categories.slug, categories.icon, categories.accent)
    .orderBy(categories.name)
}

export async function marketStats(marketId: string) {
  await ensureCatalog()
  const [result] = await db
    .select({
      tradeCount: sql<number>`count(*)`,
      volumePaise: sql<number>`coalesce(sum(${trades.amountPaise}), 0)`,
      participants: sql<number>`count(distinct ${trades.userId})`,
    })
    .from(trades)
    .where(eq(trades.marketId, marketId))

  return {
    tradeCount: Number(result?.tradeCount ?? 0),
    volumePaise: Number(result?.volumePaise ?? 0),
    participants: Number(result?.participants ?? 0),
  }
}

function toPosition(row: typeof positions.$inferSelect): Position {
  return {
    id: row.id,
    marketId: row.marketId,
    outcomeId: row.outcomeId,
    milliShares: row.milliShares,
    averagePricePaise: row.averagePricePaise,
    realisedPnlPaise: row.realisedPnlPaise,
    status: row.status as Position['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toTransaction(row: typeof transactions.$inferSelect): Transaction {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type as Transaction['type'],
    amountPaise: row.amountPaise,
    status: row.status as Transaction['status'],
    createdAt: row.createdAt,
    description: row.description,
    marketId: row.marketId ?? undefined,
  }
}

function toTrade(row: typeof trades.$inferSelect): Trade {
  return {
    id: row.id,
    marketId: row.marketId,
    outcomeId: row.outcomeId,
    side: row.side as Trade['side'],
    milliShares: row.milliShares,
    pricePaise: row.pricePaise,
    amountPaise: row.amountPaise,
    createdAt: row.createdAt,
  }
}

function toNotification(row: typeof notifications.$inferSelect): Notification {
  return {
    id: row.id,
    eventKey: row.eventKey,
    kind: row.kind as Notification['kind'],
    title: row.title,
    description: row.description,
    href: row.href ?? undefined,
    readAt: row.readAt ?? undefined,
    createdAt: row.createdAt,
  }
}

function referralSummaryFromRows(rows: Array<typeof referrals.$inferSelect>, userId: string): ReferralSummary {
  const personal = rows.find((row) => row.referrerUserId === userId && row.referredUserId === null)
  const invited = rows.filter((row) => row.referrerUserId === userId && row.referredUserId !== null)
  return {
    code: personal?.code ?? `PREDIK${userId.replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase()}`,
    invitedCount: invited.length,
    claimedCount: invited.filter((row) => row.status === 'claimed').length,
    rewardPaise: invited.reduce((sum, row) => sum + row.rewardPaise, 0),
    referrals: invited.map((row) => ({
      id: row.id,
      status: row.status,
      rewardPaise: row.rewardPaise,
      createdAt: row.createdAt,
      claimedAt: row.claimedAt ?? undefined,
    })),
  }
}

export interface AccountSnapshot {
  wallet: Wallet
  positions: Position[]
  transactions: Transaction[]
  trades: Trade[]
  watchlist: string[]
  notifications: Notification[]
  unreadNotifications: number
  profileStats: ProfileStats
  referral: ReferralSummary
  /** Payment requests (deposits/withdrawals/refunds) with provider + reconciliation state. */
  payments: PaymentRecord[]
  paymentsSummary: PaymentModeSummary
}

function toPaymentRecord(row: typeof paymentIntents.$inferSelect): PaymentRecord {
  return {
    id: row.id,
    userId: row.userId,
    direction: row.direction as PaymentDirection,
    status: row.status as PaymentStatus,
    mode: row.mode as PaymentRecord['mode'],
    provider: row.provider,
    providerPaymentId: row.providerPaymentId ?? undefined,
    providerReference: row.providerReference ?? undefined,
    providerStatus: row.providerStatus ?? undefined,
    currency: row.currency,
    amountPaise: row.amountPaise,
    feePaise: row.feePaise,
    netPaise: row.netPaise,
    method: row.method ?? undefined,
    destination: row.destination ?? undefined,
    transactionId: row.transactionId ?? undefined,
    parentPaymentId: row.parentPaymentId ?? undefined,
    refundStatus: row.refundStatus as PaymentRecord['refundStatus'],
    reconciliationStatus: row.reconciliationStatus as ReconciliationStatus,
    failureCode: row.failureCode ?? undefined,
    failureReason: row.failureReason ?? undefined,
    // Only a vetted provider checkout page is ever handed to the browser.
    checkoutUrl: safeCheckoutUrl(row.checkoutUrl),
    recheckAttempts: row.recheckAttempts,
    lastRecheckedAt: row.lastRecheckedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    settledAt: row.settledAt ?? undefined,
  }
}

/** Payment requests for one user, newest first — the wallet page history. */
export async function listPaymentsForUser(userId: string, limit = 50): Promise<PaymentRecord[]> {
  await ensurePaymentSchema()
  const rows = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.userId, userId))
    .orderBy(desc(paymentIntents.createdAt))
    .limit(limit)
  return rows.map(toPaymentRecord)
}

/**
 * Same as `listPaymentsForUser`, but tolerated inside the account snapshot: a
 * payment-table problem must never stop a user from opening their wallet.
 */
async function loadUserPayments(userId: string, limit = 50): Promise<PaymentRecord[]> {
  try {
    return await listPaymentsForUser(userId, limit)
  } catch (error) {
    console.error('[payments] could not load payment history', error)
    return []
  }
}

/**
 * Admin payment visibility: transaction id, user, amount, type, provider,
 * provider reference, status, timestamps, refund status and reconciliation
 * status. Provider secrets are never part of this payload.
 */
export async function getAdminPayments(input: {
  query?: string
  direction?: string
  status?: string
  limit?: number
} = {}): Promise<PaymentRecord[]> {
  const trimmed = (input.query ?? '').trim()
  const direction = (input.direction ?? '').trim()
  const status = (input.status ?? '').trim()
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200)
  await ensurePaymentSchema()

  const rows = await db
    .select({
      payment: paymentIntents,
      userName: users.name,
      userPhone: users.phoneNumber,
      accountStatus: paymentAccounts.status,
      kycStatus: paymentAccounts.kycStatus,
      liveEligible: paymentAccounts.liveEligible,
    })
    .from(paymentIntents)
    .innerJoin(users, eq(paymentIntents.userId, users.id))
    .leftJoin(paymentAccounts, eq(paymentAccounts.userId, paymentIntents.userId))
    .where(and(
      trimmed
        ? or(
          like(users.name, `%${trimmed}%`),
          like(users.phoneNumber, `%${trimmed}%`),
          like(paymentIntents.id, `%${trimmed}%`),
          like(paymentIntents.providerReference, `%${trimmed.toUpperCase()}%`),
          like(paymentIntents.providerPaymentId, `%${trimmed}%`),
        )
        : undefined,
      direction ? eq(paymentIntents.direction, direction) : undefined,
      status ? eq(paymentIntents.status, status) : undefined,
    ))
    .orderBy(desc(paymentIntents.createdAt))
    .limit(limit)

  return rows.map(({ payment, userName, userPhone, accountStatus, kycStatus, liveEligible }) => ({
    ...toPaymentRecord(payment),
    userName,
    userPhone: userPhone ?? '',
    accountStatus: (accountStatus ?? 'active') as PaymentRecord['accountStatus'],
    kycStatus: (kycStatus ?? 'unverified') as PaymentRecord['kycStatus'],
    liveEligible: Boolean(liveEligible),
  }))
}

/** Recent provider webhook deliveries, including rejected ones — for investigation. */
export async function listRecentWebhookEvents(limit = 20): Promise<PaymentWebhookEventSummary[]> {
  await ensurePaymentSchema()
  const rows = await db
    .select()
    .from(paymentWebhookEvents)
    .orderBy(desc(paymentWebhookEvents.receivedAt))
    .limit(Math.min(Math.max(limit, 1), 100))
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    status: row.status as PaymentWebhookEventSummary['status'],
    paymentIntentId: row.paymentIntentId ?? undefined,
    providerPaymentId: row.providerPaymentId ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  }))
}

export async function getAccountSnapshot(userId: string): Promise<AccountSnapshot> {
  return timed('account.snapshot', () => loadAccountSnapshot(userId))
}

async function loadAccountSnapshot(userId: string): Promise<AccountSnapshot> {
  const [walletRows, positionRows, transactionRows, tradeRows, watchlistRows, notificationRows, unreadRows, tradeStatsRows, positionStatsRows, referralRows, paymentRows] = await Promise.all([
    db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1),
    db.select().from(positions).where(eq(positions.userId, userId)).orderBy(desc(positions.updatedAt)),
    db.select().from(transactions).where(eq(transactions.userId, userId)).orderBy(desc(transactions.createdAt)).limit(200),
    db.select().from(trades).where(eq(trades.userId, userId)).orderBy(desc(trades.createdAt)).limit(200),
    db.select().from(watchlists).where(eq(watchlists.userId, userId)).orderBy(desc(watchlists.createdAt)),
    db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(50),
    db.select({ unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)` }).from(notifications).where(eq(notifications.userId, userId)),
    db.select({
      tradeCount: sql<number>`count(*)`,
      marketsParticipated: sql<number>`count(distinct ${trades.marketId})`,
      volumePaise: sql<number>`coalesce(sum(abs(${trades.amountPaise})), 0)`,
    }).from(trades).where(eq(trades.userId, userId)),
    db.select({
      openPositions: sql<number>`count(*) filter (where ${positions.status} = 'open')`,
      resolvedPositions: sql<number>`count(*) filter (where ${positions.status} <> 'open')`,
    }).from(positions).where(eq(positions.userId, userId)),
    db.select().from(referrals).where(eq(referrals.referrerUserId, userId)).orderBy(desc(referrals.createdAt)),
    loadUserPayments(userId, 50),
  ])

  const wallet = walletRows[0]
  const tradeStats = tradeStatsRows[0]
  const positionStats = positionStatsRows[0]
  return {
    wallet: {
      availablePaise: wallet?.availablePaise ?? 0,
      lockedPaise: wallet?.lockedPaise ?? 0,
      bonusPaise: wallet?.bonusPaise ?? 0,
    },
    positions: positionRows.map(toPosition),
    transactions: transactionRows.map(toTransaction),
    trades: tradeRows.map(toTrade),
    watchlist: watchlistRows.map((row) => row.marketId),
    notifications: notificationRows.map(toNotification),
    unreadNotifications: Number(unreadRows[0]?.unread ?? 0),
    profileStats: {
      tradeCount: Number(tradeStats?.tradeCount ?? 0),
      marketsParticipated: Number(tradeStats?.marketsParticipated ?? 0),
      openPositions: Number(positionStats?.openPositions ?? 0),
      resolvedPositions: Number(positionStats?.resolvedPositions ?? 0),
      volumePaise: Number(tradeStats?.volumePaise ?? 0),
    },
    referral: referralSummaryFromRows(referralRows, userId),
    payments: paymentRows,
    paymentsSummary: publicPaymentConfig(),
  }
}

export async function getNotifications(userId: string, limit = 50) {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
  return rows.map(toNotification)
}

export async function getUnreadNotificationCount(userId: string) {
  const [row] = await db
    .select({ unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)` })
    .from(notifications)
    .where(eq(notifications.userId, userId))
  return Number(row?.unread ?? 0)
}

/**
 * Deposits (settled) and withdrawals (pending, i.e. still locked) are the
 * only transaction types an admin can reverse from this list — trades and
 * settlements flow through market resolution instead. A refund is never
 * issued twice: any reference already carrying a `-REFUND` counterpart is
 * excluded.
 */
export async function getRefundableTransactions(query = '', limit = 50): Promise<AdminTransaction[]> {
  const trimmed = query.trim()
  const rows = await db
    .select({ transaction: transactions, userName: users.name, userPhone: users.phoneNumber })
    .from(transactions)
    .innerJoin(users, eq(transactions.userId, users.id))
    .where(and(
      or(
        and(eq(transactions.type, 'deposit'), eq(transactions.status, 'completed')),
        and(eq(transactions.type, 'withdrawal'), eq(transactions.status, 'pending')),
      ),
      trimmed
        ? or(
          like(users.phoneNumber, `%${trimmed}%`),
          like(users.name, `%${trimmed}%`),
          like(transactions.reference, `%${trimmed.toUpperCase()}%`),
        )
        : undefined,
    ))
    .orderBy(desc(transactions.createdAt))
    .limit(200)

  const refundRefs = await db
    .select({ reference: transactions.reference })
    .from(transactions)
    .where(eq(transactions.type, 'refund'))
  const refundedOriginals = new Set(refundRefs.map((r) => r.reference.replace(/-REFUND$/, '')))

  return rows
    .map(({ transaction, userName, userPhone }) => ({
      id: transaction.id,
      reference: transaction.reference,
      type: transaction.type as AdminTransaction['type'],
      amountPaise: transaction.amountPaise,
      status: transaction.status as AdminTransaction['status'],
      createdAt: transaction.createdAt,
      description: transaction.description,
      userId: transaction.userId,
      userName,
      userPhone: userPhone ?? '',
      refundable: !refundedOriginals.has(transaction.reference),
    }))
    .filter((t) => t.refundable)
    .slice(0, limit)
}

export async function getReferralSummary(userId: string) {
  const rows = await db
    .select()
    .from(referrals)
    .where(eq(referrals.referrerUserId, userId))
    .orderBy(desc(referrals.createdAt))
  return referralSummaryFromRows(rows, userId)
}
