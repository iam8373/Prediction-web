import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const users = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  phoneNumber: text('phoneNumber'),
  phoneNumberVerified: boolean('phoneNumberVerified').notNull().default(false),
  avatarColor: text('avatarColor').notNull().default('oklch(0.65 0.2 30)'),
  isAdmin: boolean('isAdmin').notNull().default(false),
  createdAt: timestamp('createdAt', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().defaultNow(),
}, (table) => ({
  emailIdx: uniqueIndex('user_email_idx').on(table.email),
  phoneIdx: uniqueIndex('user_phone_idx').on(table.phoneNumber),
}))

export const sessions = pgTable('session', {
  token: text('token').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
}, (table) => ({
  userIdx: index('session_user_idx').on(table.userId),
  expiryIdx: index('session_expiry_idx').on(table.expiresAt),
}))

export const otpChallenges = pgTable('otp_challenge', {
  id: text('id').primaryKey(),
  phone: text('phone').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
}, (table) => ({
  phoneIdx: index('otp_phone_idx').on(table.phone),
  expiryIdx: index('otp_expiry_idx').on(table.expiresAt),
}))

export const categories = pgTable('category', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  icon: text('icon').notNull(),
  accent: text('accent').notNull(),
}, (table) => ({
  slugIdx: uniqueIndex('category_slug_idx').on(table.slug),
}))

export const markets = pgTable('market', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  question: text('question').notNull(),
  headline: text('headline').notNull(),
  description: text('description').notNull(),
  resolutionCriteria: text('resolution_criteria').notNull(),
  source: text('source').notNull(),
  categoryId: text('category_id').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  league: text('league'),
  emblem: text('emblem').notNull(),
  live: boolean('live').notNull().default(false),
  featured: boolean('featured').notNull().default(false),
  bonus: boolean('bonus').notNull().default(false),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  opensAt: bigint('opens_at', { mode: 'number' }).notNull(),
  closesAt: bigint('closes_at', { mode: 'number' }).notNull(),
  resolvesAt: bigint('resolves_at', { mode: 'number' }).notNull(),
  resolvedOutcomeId: text('resolved_outcome_id'),
  volumePaise: bigint('volume_paise', { mode: 'number' }).notNull().default(0),
  liquidityPaise: bigint('liquidity_paise', { mode: 'number' }).notNull().default(0),
  traders: integer('traders').notNull().default(0),
}, (table) => ({
  slugIdx: uniqueIndex('market_slug_idx').on(table.slug),
  categoryIdx: index('market_category_idx').on(table.categoryId),
  statusIdx: index('market_status_idx').on(table.status),
  closesIdx: index('market_closes_idx').on(table.closesAt),
}))

export const marketOutcomes = pgTable('market_outcome', {
  id: text('id').primaryKey(),
  marketId: text('market_id').notNull(),
  name: text('name').notNull(),
  side: text('side').notNull(),
  pricePaise: integer('price_paise').notNull(),
  previousPricePaise: integer('previous_price_paise').notNull(),
}, (table) => ({
  marketIdx: index('market_outcome_market_idx').on(table.marketId),
}))

export const marketPriceHistory = pgTable('market_price_history', {
  id: text('id').primaryKey(),
  marketId: text('market_id').notNull(),
  t: bigint('t', { mode: 'number' }).notNull(),
  yesPricePaise: integer('yes_price_paise').notNull(),
}, (table) => ({
  marketTimeIdx: index('market_price_history_market_time_idx').on(table.marketId, table.t),
}))

export const wallets = pgTable('wallet', {
  userId: text('user_id').primaryKey(),
  availablePaise: bigint('available_paise', { mode: 'number' }).notNull().default(0),
  lockedPaise: bigint('locked_paise', { mode: 'number' }).notNull().default(0),
  bonusPaise: bigint('bonus_paise', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
})

export const ledgerEntries = pgTable('ledger_entry', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  reference: text('reference').notNull(),
  type: text('type').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  status: text('status').notNull(),
  description: text('description').notNull(),
  marketId: text('market_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  referenceIdx: uniqueIndex('ledger_reference_idx').on(table.reference),
  userCreatedIdx: index('ledger_user_created_idx').on(table.userId, table.createdAt),
}))

export const transactions = pgTable('transaction', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  reference: text('reference').notNull(),
  type: text('type').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  status: text('status').notNull(),
  description: text('description').notNull(),
  marketId: text('market_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  referenceIdx: uniqueIndex('transaction_reference_idx').on(table.reference),
  userCreatedIdx: index('transaction_user_created_idx').on(table.userId, table.createdAt),
}))

export const positions = pgTable('position', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  marketId: text('market_id').notNull(),
  outcomeId: text('outcome_id').notNull(),
  milliShares: bigint('milli_shares', { mode: 'number' }).notNull(),
  averagePricePaise: integer('average_price_paise').notNull(),
  realisedPnlPaise: bigint('realised_pnl_paise', { mode: 'number' }).notNull().default(0),
  status: text('status').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  userOutcomeIdx: index('position_user_outcome_idx').on(table.userId, table.outcomeId),
  userStatusIdx: index('position_user_status_idx').on(table.userId, table.status),
}))

export const trades = pgTable('trade', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  marketId: text('market_id').notNull(),
  outcomeId: text('outcome_id').notNull(),
  side: text('side').notNull(),
  milliShares: bigint('milli_shares', { mode: 'number' }).notNull(),
  pricePaise: integer('price_paise').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  marketCreatedIdx: index('trade_market_created_idx').on(table.marketId, table.createdAt),
  userCreatedIdx: index('trade_user_created_idx').on(table.userId, table.createdAt),
}))

export const idempotencyKeys = pgTable('idempotency_key', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  requestKey: text('request_key').notNull(),
  response: jsonb('response').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
}, (table) => ({
  requestIdx: uniqueIndex('idempotency_user_request_idx').on(table.userId, table.requestKey),
}))

export const notifications = pgTable('notification', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  eventKey: text('event_key').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  href: text('href'),
  readAt: bigint('read_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  userEventIdx: uniqueIndex('notification_user_event_idx').on(table.userId, table.eventKey),
  unreadIdx: index('notification_user_unread_idx').on(table.userId, table.readAt, table.createdAt),
}))

export const referrals = pgTable('referral', {
  id: text('id').primaryKey(),
  referrerUserId: text('referrer_user_id').notNull(),
  referredUserId: text('referred_user_id'),
  code: text('code').notNull(),
  status: text('status').notNull().default('pending'),
  rewardPaise: bigint('reward_paise', { mode: 'number' }).notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  claimedAt: bigint('claimed_at', { mode: 'number' }),
}, (table) => ({
  codeIdx: uniqueIndex('referral_code_idx').on(table.code),
  referrerIdx: index('referral_referrer_idx').on(table.referrerUserId, table.createdAt),
}))

/**
 * Payment eligibility / account state. Payment eligibility is intentionally
 * separate from the `user` row: pre-existing users keep working untouched, and
 * compliance state can move without touching authentication or trading.
 */
export const paymentAccounts = pgTable('payment_account', {
  userId: text('user_id').primaryKey(),
  /** active | restricted | blocked */
  status: text('status').notNull().default('active'),
  /** unverified | pending | verified | rejected */
  kycStatus: text('kyc_status').notNull().default('unverified'),
  /** ISO jurisdiction used by the live-money gate. */
  jurisdiction: text('jurisdiction'),
  /** Explicit per-account approval for real-money flows. */
  liveEligible: boolean('live_eligible').notNull().default(false),
  restrictedReason: text('restricted_reason'),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
}, (table) => ({
  statusIdx: index('payment_account_status_idx').on(table.status),
}))

/**
 * The authoritative payment record. Payment state is deliberately separate
 * from wallet state: a payment can be created, pending or failed without the
 * wallet ever moving, and only `verified -> completed` touches balances.
 */
export const paymentIntents = pgTable('payment_intent', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  /** deposit | withdrawal | refund */
  direction: text('direction').notNull(),
  /** see lib/payments/state-machine.ts */
  status: text('status').notNull(),
  /** demo | sandbox | live at the time the payment was created. */
  mode: text('mode').notNull(),
  provider: text('provider').notNull(),
  providerStatus: text('provider_status'),
  currency: text('currency').notNull(),
  /** Requested amount in integer paise — never a float. */
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  providerAmountPaise: bigint('provider_amount_paise', { mode: 'number' }),
  feePaise: bigint('fee_paise', { mode: 'number' }).notNull().default(0),
  netPaise: bigint('net_paise', { mode: 'number' }).notNull().default(0),
  method: text('method'),
  /** Withdrawal destination (UPI ID). Never a secret. */
  destination: text('destination'),
  providerPaymentId: text('provider_payment_id'),
  providerReference: text('provider_reference'),
  /** Provider anchor entity (order id / payout id) kept for verification. */
  providerOrderRef: text('provider_order_ref'),
  /** Provider destination handle (e.g. fund account) reused across retries. */
  providerDestinationRef: text('provider_destination_ref'),
  /** UUID sent as the provider's idempotency key; reused on every retry. */
  providerIdempotencyKey: text('provider_idempotency_key'),
  /** Hosted checkout link the user was sent to, when the provider returns one. */
  checkoutUrl: text('checkout_url'),
  /** Bounded status re-check bookkeeping for payments stuck pending/processing. */
  recheckAttempts: integer('recheck_attempts').notNull().default(0),
  lastRecheckedAt: bigint('last_rechecked_at', { mode: 'number' }),
  /** Caller supplied idempotency key for this payment request. */
  requestKey: text('request_key').notNull(),
  /** Internal transaction row created when the payment settles/reserves. */
  transactionId: text('transaction_id'),
  /** Refunds point at the payment they reverse. */
  parentPaymentId: text('parent_payment_id'),
  /** none | full | partial */
  refundStatus: text('refund_status').notNull().default('none'),
  /** see ReconciliationStatus */
  reconciliationStatus: text('reconciliation_status').notNull().default('unchecked'),
  failureCode: text('failure_code'),
  failureReason: text('failure_reason'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  settledAt: bigint('settled_at', { mode: 'number' }),
}, (table) => ({
  requestIdx: uniqueIndex('payment_intent_request_idx').on(table.userId, table.requestKey),
  providerPaymentIdx: uniqueIndex('payment_intent_provider_payment_idx').on(table.provider, table.providerPaymentId),
  userCreatedIdx: index('payment_intent_user_created_idx').on(table.userId, table.createdAt),
  statusIdx: index('payment_intent_status_idx').on(table.status),
  reconciliationIdx: index('payment_intent_reconciliation_idx').on(table.reconciliationStatus),
  parentIdx: index('payment_intent_parent_idx').on(table.parentPaymentId),
  providerOrderIdx: index('payment_intent_provider_order_idx').on(table.providerOrderRef),
}))

/**
 * Every provider webhook delivery we received, verified or not. The unique
 * (provider, provider_event_id) index is what guarantees one economic effect
 * per provider event, including retries.
 */
export const paymentWebhookEvents = pgTable('payment_webhook_event', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  eventType: text('event_type').notNull(),
  /** received | processed | ignored | failed | rejected */
  status: text('status').notNull(),
  paymentIntentId: text('payment_intent_id'),
  providerPaymentId: text('provider_payment_id'),
  /** sha256 fingerprint of the raw body — useful, never the secret itself. */
  payloadFingerprint: text('payload_fingerprint').notNull(),
  error: text('error'),
  attempts: integer('attempts').notNull().default(1),
  receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
  processedAt: bigint('processed_at', { mode: 'number' }),
}, (table) => ({
  eventIdx: uniqueIndex('payment_webhook_event_unique_idx').on(table.provider, table.providerEventId),
  statusIdx: index('payment_webhook_event_status_idx').on(table.status, table.receivedAt),
  paymentIdx: index('payment_webhook_event_payment_idx').on(table.paymentIntentId),
}))

export const paymentReconciliationRuns = pgTable('payment_reconciliation_run', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  mode: text('mode').notNull(),
  /** running | completed | failed */
  status: text('status').notNull(),
  checkedCount: integer('checked_count').notNull().default(0),
  matchedCount: integer('matched_count').notNull().default(0),
  mismatchCount: integer('mismatch_count').notNull().default(0),
  notes: text('notes'),
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  finishedAt: bigint('finished_at', { mode: 'number' }),
  triggeredByUserId: text('triggered_by_user_id'),
}, (table) => ({
  startedIdx: index('payment_reconciliation_run_started_idx').on(table.startedAt),
  providerIdx: index('payment_reconciliation_run_provider_idx').on(table.provider, table.startedAt),
}))

/** Mismatches are recorded for controlled handling and never auto-corrected. */
export const paymentReconciliationFindings = pgTable('payment_reconciliation_finding', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  provider: text('provider').notNull(),
  paymentIntentId: text('payment_intent_id').notNull(),
  status: text('status').notNull(),
  internalStatus: text('internal_status'),
  providerStatus: text('provider_status'),
  internalAmountPaise: bigint('internal_amount_paise', { mode: 'number' }),
  providerAmountPaise: bigint('provider_amount_paise', { mode: 'number' }),
  notes: text('notes'),
  resolvedAt: bigint('resolved_at', { mode: 'number' }),
  resolvedByUserId: text('resolved_by_user_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  runPaymentIdx: uniqueIndex('payment_reconciliation_finding_run_idx').on(table.runId, table.paymentIntentId),
  paymentIdx: index('payment_reconciliation_finding_payment_idx').on(table.paymentIntentId, table.createdAt),
  statusIdx: index('payment_reconciliation_finding_status_idx').on(table.status, table.createdAt),
}))

/**
 * Audit trail for administrative financial actions (refunds, withdrawal
 * cancellation/completion, reconciliation runs, manual state changes). Kept in
 * the same database as everything else — no separate audit store.
 */
export const auditLogs = pgTable('audit_log', {
  id: text('id').primaryKey(),
  /** admin | system | provider | user */
  actorRole: text('actor_role').notNull(),
  actorUserId: text('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  summary: text('summary').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  entityIdx: index('audit_log_entity_idx').on(table.entityType, table.entityId),
  actionIdx: index('audit_log_action_idx').on(table.action, table.createdAt),
  actorIdx: index('audit_log_actor_idx').on(table.actorUserId, table.createdAt),
}))

/**
 * Rate limiting counters.
 *
 * Server-side abuse protection for high-risk endpoints (OTP, withdrawals,
 * deposits, trading, refunds, webhooks, admin actions). Backed by PostgreSQL so
 * the limit is shared by every instance of the deployment — an in-process
 * counter would be trivially defeated by a horizontally scaled runtime.
 *
 * Keys are stored as SHA-256 digests (`key_hash`) so the table never becomes a
 * secondary store of phone numbers or IP addresses, and the row id embeds the
 * bucket, key and window so one atomic upsert both starts and increments a
 * window (`on conflict ... count = count + 1`).
 */
export const rateLimitCounters = pgTable('rate_limit_counter', {
  id: text('id').primaryKey(),
  bucket: text('bucket').notNull(),
  keyHash: text('key_hash').notNull(),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
  count: integer('count').notNull().default(0),
  /** Row is dead after this instant; purged opportunistically. */
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
}, (table) => ({
  bucketKeyIdx: index('rate_limit_bucket_key_idx').on(table.bucket, table.keyHash, table.windowStart),
  expiryIdx: index('rate_limit_expiry_idx').on(table.expiresAt),
}))

export const watchlists = pgTable('watchlist', {
  userId: text('user_id').notNull(),
  marketId: text('market_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  userCreatedIdx: index('watchlist_user_created_idx').on(table.userId, table.createdAt),
}))

export const user = users
export const session = sessions
export const category = categories
export const market = markets
export const marketOutcome = marketOutcomes
export const wallet = wallets
export const ledgerEntry = ledgerEntries
export const transaction = transactions
export const position = positions
export const trade = trades
export const idempotencyKey = idempotencyKeys
export const notification = notifications
export const referral = referrals
export const watchlist = watchlists
export const rateLimitCounter = rateLimitCounters
export const paymentAccount = paymentAccounts
export const paymentIntent = paymentIntents
export const paymentWebhookEvent = paymentWebhookEvents
export const paymentReconciliationRun = paymentReconciliationRuns
export const paymentReconciliationFinding = paymentReconciliationFindings
export const auditLog = auditLogs

export type User = typeof users.$inferSelect

export type PaymentAccountRow = typeof paymentAccounts.$inferSelect
export type PaymentIntentRow = typeof paymentIntents.$inferSelect
export type PaymentWebhookEventRow = typeof paymentWebhookEvents.$inferSelect
export type PaymentReconciliationRunRow = typeof paymentReconciliationRuns.$inferSelect
export type PaymentReconciliationFindingRow = typeof paymentReconciliationFindings.$inferSelect
export type AuditLogRow = typeof auditLogs.$inferSelect
export type WalletRow = typeof wallets.$inferSelect
export type MarketRow = typeof markets.$inferSelect
export type MarketOutcomeRow = typeof marketOutcomes.$inferSelect
export type PositionRow = typeof positions.$inferSelect
export type TransactionRow = typeof transactions.$inferSelect
export type TradeRow = typeof trades.$inferSelect
export type NotificationRow = typeof notifications.$inferSelect
export type ReferralRow = typeof referrals.$inferSelect
export type WatchlistRow = typeof watchlists.$inferSelect
