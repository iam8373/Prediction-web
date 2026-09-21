'use client'

import { create } from 'zustand'

import type {
  AdminTransaction,
  AuditTrailEntry,
  Market,
  Notification,
  PaymentModeSummary,
  PaymentRecheckSummary,
  PaymentRecord,
  PaymentWebhookEventSummary,
  Position,
  ProfileStats,
  ReconciliationFinding,
  ReconciliationRunSummary,
  ReferralSummary,
  SessionUser,
  Trade,
  Transaction,
  Wallet,
  WalletLedgerAudit,
} from '@/types'
import type { MarketFormInput } from '@/lib/validation/schemas'

export interface ActionResult {
  ok: boolean
  error?: string
  transactionId?: string
  paymentId?: string
  /** Payment status after the request (e.g. pending in sandbox mode). */
  paymentStatus?: string
  /** Hosted provider checkout link the user must be sent to, when one exists. */
  checkoutUrl?: string
  /** Provider order id for the Orders/Checkout.js deposit flow. */
  providerOrderId?: string
  /** True when the payment needs controlled review before any credit. */
  reviewRequired?: boolean
}

/**
 * Outcome of asking the server for a sign-in code.
 *
 * `demoCode` is present only when the server deliberately disclosed the code,
 * and `delivery` says how the code reached the user ('shared-code' when nothing
 * was dispatched as a message). The screen must never assume either.
 */
export interface OtpRequestResult {
  ok: boolean
  error?: string
  demoCode?: string
  delivery?: 'sms' | 'shared-code'
}

interface AccountPayload {
  user: SessionUser
  wallet: Wallet
  positions: Position[]
  transactions: Transaction[]
  trades: Trade[]
  watchlist: string[]
  notifications: Notification[]
  unreadNotifications: number
  profileStats: ProfileStats
  referral: ReferralSummary
  payments: PaymentRecord[]
  paymentsSummary: PaymentModeSummary
}

interface AppState {
  hydrated: boolean
  user: SessionUser | null
  wallet: Wallet
  positions: Position[]
  transactions: Transaction[]
  trades: Trade[]
  markets: Market[]
  watchlist: string[]
  notifications: Notification[]
  unreadNotifications: number
  profileStats: ProfileStats
  referral: ReferralSummary
  payments: PaymentRecord[]
  paymentsSummary: PaymentModeSummary | null
  pendingOtp: string | null
  adminTransactions: AdminTransaction[]
  adminTransactionsLoading: boolean
  adminPayments: PaymentRecord[]
  adminWebhookEvents: PaymentWebhookEventSummary[]
  adminReconciliationRuns: ReconciliationRunSummary[]
  adminReconciliationFindings: ReconciliationFinding[]
  adminAuditTrail: AuditTrailEntry[]
  adminAwaitingProvider: number
  adminPaymentsLoading: boolean

  hydrate: () => Promise<void>
  requestOtp: (phone: string) => Promise<OtpRequestResult>
  signIn: (phone: string, otp: string) => Promise<ActionResult>
  signOut: () => Promise<void>
  deposit: (amountPaise: number, method?: 'upi' | 'netbanking' | 'demo') => Promise<ActionResult>
  withdraw: (amountPaise: number, destination: string) => Promise<ActionResult>
  buy: (marketId: string, outcomeId: string, amountPaise: number) => Promise<ActionResult>
  sell: (marketId: string, outcomeId: string, milliShares: number) => Promise<ActionResult>
  toggleWatch: (marketId: string) => Promise<ActionResult>
  markNotificationRead: (id: string) => Promise<ActionResult>
  markAllNotificationsRead: () => Promise<ActionResult>
  claimReferral: (code: string) => Promise<ActionResult>
  createMarket: (input: MarketFormInput) => Promise<ActionResult>
  resolveMarket: (marketId: string, outcomeId: string) => Promise<ActionResult>
  setMarketStatus: (marketId: string, status: 'open' | 'paused' | 'closed') => Promise<ActionResult>
  adminFetchTransactions: (query?: string) => Promise<void>
  adminRefundTransaction: (transactionId: string, reason?: string) => Promise<ActionResult>
  refreshPayments: () => Promise<void>
  adminFetchPayments: (query?: string) => Promise<void>
  adminRunReconciliation: () => Promise<ActionResult>
  adminRecheckPayments: () => Promise<ActionResult>
  adminRunRetention: (dryRun?: boolean) => Promise<ActionResult>
  adminAuditWallet: (userId: string) => Promise<ActionResult>
  adminResolveWithdrawal: (paymentId: string, action: 'complete' | 'fail' | 'cancel', reason?: string) => Promise<ActionResult>
  adminSimulateSandboxPayment: (paymentId: string, outcome: 'succeeded' | 'failed') => Promise<ActionResult>
}

const emptyWallet: Wallet = { availablePaise: 0, lockedPaise: 0, bonusPaise: 0 }

function requestId() {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T
  if (!response.ok) throw new Error((body as { error?: string }).error ?? 'Request failed')
  return body
}

async function fetchMarkets() {
  const response = await fetch('/api/markets', { cache: 'no-store' })
  return readJson<{ markets: Market[] }>(response)
}

async function fetchAccount() {
  const response = await fetch('/api/me', { cache: 'no-store' })
  if (response.status === 401) return null
  return readJson<AccountPayload>(response)
}

const emptyProfileStats: ProfileStats = {
  tradeCount: 0,
  marketsParticipated: 0,
  openPositions: 0,
  resolvedPositions: 0,
  volumePaise: 0,
}

const emptyReferral: ReferralSummary = {
  code: '',
  invitedCount: 0,
  claimedCount: 0,
  rewardPaise: 0,
  referrals: [],
}

const resetAccount = {
  user: null as SessionUser | null,
  wallet: emptyWallet,
  positions: [] as Position[],
  transactions: [] as Transaction[],
  trades: [] as Trade[],
  watchlist: [] as string[],
  notifications: [] as Notification[],
  unreadNotifications: 0,
  profileStats: emptyProfileStats,
  referral: emptyReferral,
  payments: [] as PaymentRecord[],
  paymentsSummary: null as PaymentModeSummary | null,
}

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
  ...resetAccount,
  markets: [],
  pendingOtp: null,
  adminTransactions: [],
  adminTransactionsLoading: false,
  adminPayments: [],
  adminWebhookEvents: [],
  adminReconciliationRuns: [],
  adminReconciliationFindings: [],
  adminAuditTrail: [],
  adminAwaitingProvider: 0,
  adminPaymentsLoading: false,

  async hydrate() {
    if (get().hydrated) return
    try {
      const [account, marketPayload] = await Promise.all([fetchAccount(), fetchMarkets()])
      set({
        hydrated: true,
        markets: marketPayload.markets,
        ...(account ?? resetAccount),
      })
    } catch (error) {
      console.error('[store] account hydration failed', error)
      set({ hydrated: true })
    }
  },

  async requestOtp(phone) {
    try {
      const response = await fetch('/api/auth/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request', phone }),
      })
      const body = (await response.json().catch(() => ({}))) as OtpRequestResult

      // A rejected request means no code was issued — a rate limit, or a
      // deployment with no sign-in delivery configured. Report it instead of
      // pretending the code was sent.
      if (!response.ok) {
        return { ok: false, error: body.error ?? 'We could not send a sign-in code. Try again.' }
      }

      // Only ever surface a code the server actually disclosed. Inventing a
      // fallback would look like a successful send and then fail to sign in.
      set({ pendingOtp: body.demoCode ?? null })
      return { ok: true, demoCode: body.demoCode, delivery: body.delivery ?? 'shared-code' }
    } catch {
      return { ok: false, error: 'We could not reach Predik. Check your connection and try again.' }
    }
  },

  async signIn(phone, otp) {
    try {
      const response = await fetch('/api/auth/otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', phone, otp }),
      })
      const body = await readJson<{ user: SessionUser }>(response)
      const [account, marketPayload] = await Promise.all([fetchAccount(), fetchMarkets()])
      if (!account) return { ok: false, error: 'We could not load your account. Try again.' }
      set({ ...account, markets: marketPayload.markets, hydrated: true, pendingOtp: null })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Sign in failed' }
    }
  },

  async signOut() {
    try {
      await fetch('/api/auth/sign-out', { method: 'POST' })
    } finally {
      set({ ...resetAccount, hydrated: true, pendingOtp: null })
    }
  },

  async deposit(amountPaise, method = 'demo') {
    try {
      const response = await fetch('/api/wallet/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId() },
        body: JSON.stringify({ amountPaise, method }),
      })
      const body = await readJson<{ transactionId?: string; paymentId: string; status: string; checkoutUrl?: string; providerOrderId?: string; reviewRequired?: boolean }>(response)
      const account = await fetchAccount()
      if (account) set(account)
      return {
        ok: true,
        transactionId: body.transactionId,
        paymentId: body.paymentId,
        paymentStatus: body.status,
        checkoutUrl: body.checkoutUrl,
        providerOrderId: body.providerOrderId,
        reviewRequired: body.reviewRequired,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Deposit failed' }
    }
  },

  async withdraw(amountPaise, destination) {
    try {
      const response = await fetch('/api/wallet/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId() },
        body: JSON.stringify({ amountPaise, destination }),
      })
      const body = await readJson<{ transactionId?: string; paymentId: string; status: string; reviewRequired?: boolean }>(response)
      const account = await fetchAccount()
      if (account) set(account)
      return { ok: true, transactionId: body.transactionId, paymentId: body.paymentId, paymentStatus: body.status, reviewRequired: body.reviewRequired }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Withdrawal failed' }
    }
  },

  async refreshPayments() {
    try {
      const response = await fetch('/api/wallet/payments', { cache: 'no-store' })
      const body = await readJson<{ payments: PaymentRecord[]; summary: PaymentModeSummary }>(response)
      set({ payments: body.payments, paymentsSummary: body.summary })
    } catch (error) {
      console.error('[store] payment refresh failed', error)
    }
  },

  async adminFetchPayments(query = '') {
    set({ adminPaymentsLoading: true })
    try {
      const response = await fetch(`/api/admin/payments?query=${encodeURIComponent(query)}`, { cache: 'no-store' })
      const body = await readJson<{
        payments: PaymentRecord[]
        webhookEvents: PaymentWebhookEventSummary[]
        reconciliation: { runs: ReconciliationRunSummary[]; findings: ReconciliationFinding[] }
        auditTrail: AuditTrailEntry[]
        awaitingProvider: number
        summary: PaymentModeSummary
      }>(response)
      set({
        adminPayments: body.payments,
        adminWebhookEvents: body.webhookEvents,
        adminReconciliationRuns: body.reconciliation.runs,
        adminReconciliationFindings: body.reconciliation.findings,
        adminAuditTrail: body.auditTrail,
        adminAwaitingProvider: body.awaitingProvider,
        paymentsSummary: body.summary,
        adminPaymentsLoading: false,
      })
    } catch (error) {
      console.error('[store] admin payment fetch failed', error)
      set({ adminPaymentsLoading: false })
    }
  },

  async adminRunReconciliation() {
    try {
      const response = await fetch('/api/admin/payments/reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await readJson<{ run: ReconciliationRunSummary }>(response)
      await get().adminFetchPayments()
      return {
        ok: true,
        paymentStatus: `${body.run.matchedCount}/${body.run.checkedCount} matched`,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Reconciliation failed' }
    }
  },

  async adminRecheckPayments() {
    try {
      const response = await fetch('/api/admin/payments/recheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // An admin asking explicitly skips the backoff, but the per-payment
        // attempt budget still applies — nothing is polled forever.
        body: JSON.stringify({ force: true }),
      })
      const body = await readJson<{ summary: PaymentRecheckSummary }>(response)
      await get().adminFetchPayments()
      const { settled, stillPending, flagged, checked } = body.summary
      return {
        ok: true,
        paymentStatus: `${checked} checked · ${settled} settled · ${stillPending} pending · ${flagged} flagged`,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Re-check failed' }
    }
  },

  async adminRunRetention(dryRun = true) {
    try {
      const response = await fetch('/api/admin/payments/retention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun }),
      })
      const body = await readJson<{ result: { webhookEvents: number; rejectedWebhookEvents: number; reconciliationFindings: number; dryRun: boolean } }>(response)
      const total = body.result.webhookEvents + body.result.rejectedWebhookEvents + body.result.reconciliationFindings
      return {
        ok: true,
        paymentStatus: body.result.dryRun ? `${total} records would be purged` : `${total} records purged`,
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Retention run failed' }
    }
  },

  async adminAuditWallet(userId) {
    try {
      const response = await fetch(`/api/admin/payments/wallet-audit?userId=${encodeURIComponent(userId)}`, { cache: 'no-store' })
      const body = await readJson<{ audit: WalletLedgerAudit }>(response)
      const { status, differencePaise, bonusDifferencePaise, expectedTotalPaise, actualTotalPaise } = body.audit
      return {
        ok: true,
        paymentStatus: status === 'matched'
          ? 'Wallet matches the ledger'
          : `Difference of ${differencePaise} paise spendable (ledger ${expectedTotalPaise} vs wallet ${actualTotalPaise})` +
            (bonusDifferencePaise !== 0 ? `, ${bonusDifferencePaise} paise bonus` : ''),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Wallet audit failed' }
    }
  },

  async adminResolveWithdrawal(paymentId, action, reason) {
    try {
      const response = await fetch('/api/admin/payments/withdrawals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId, action, reason }),
      })
      const body = await readJson<{ status: string }>(response)
      await get().adminFetchPayments()
      return { ok: true, paymentId, paymentStatus: body.status }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not update the withdrawal' }
    }
  },

  async adminSimulateSandboxPayment(paymentId, outcome) {
    try {
      const response = await fetch('/api/admin/payments/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId, outcome }),
      })
      await readJson<{ webhook: Record<string, unknown> }>(response)
      await get().adminFetchPayments()
      return { ok: true, paymentId, paymentStatus: outcome }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Simulation failed' }
    }
  },

  async buy(marketId, outcomeId, amountPaise) {
    try {
      const response = await fetch('/api/trading/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId() },
        body: JSON.stringify({ marketId, outcomeId, side: 'buy', amountPaise }),
      })
      const body = await readJson<{ transactionId: string }>(response)
      const [account, marketPayload] = await Promise.all([fetchAccount(), fetchMarkets()])
      if (account) set({ ...account, markets: marketPayload.markets })
      return { ok: true, transactionId: body.transactionId }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Trade failed' }
    }
  },

  async sell(marketId, outcomeId, milliShares) {
    try {
      const response = await fetch('/api/trading/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId() },
        body: JSON.stringify({ marketId, outcomeId, milliShares }),
      })
      const body = await readJson<{ transactionId: string }>(response)
      const [account, marketPayload] = await Promise.all([fetchAccount(), fetchMarkets()])
      if (account) set({ ...account, markets: marketPayload.markets })
      return { ok: true, transactionId: body.transactionId }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Sell failed' }
    }
  },

  async toggleWatch(marketId) {
    const wasWatching = get().watchlist.includes(marketId)
    const nextWatchlist = wasWatching
      ? get().watchlist.filter((id) => id !== marketId)
      : [marketId, ...get().watchlist]
    set({ watchlist: nextWatchlist })

    try {
      const response = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId() },
        body: JSON.stringify({ marketId, watched: !wasWatching }),
      })
      const body = await readJson<{ watched: boolean; watchlist: string[] }>(response)
      set({ watchlist: body.watchlist })
      return { ok: true }
    } catch (error) {
      set({ watchlist: wasWatching ? [...nextWatchlist, marketId] : nextWatchlist.filter((id) => id !== marketId) })
      return { ok: false, error: error instanceof Error ? error.message : 'Could not update watchlist' }
    }
  },

  async markNotificationRead(id) {
    try {
      const response = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const body = await readJson<{ notifications: Notification[]; unread: number }>(response)
      set({ notifications: body.notifications, unreadNotifications: body.unread })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not update notification' }
    }
  },

  async markAllNotificationsRead() {
    try {
      const response = await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const body = await readJson<{ notifications: Notification[]; unread: number }>(response)
      set({ notifications: body.notifications, unreadNotifications: body.unread })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not update notifications' }
    }
  },

  async claimReferral(code) {
    try {
      const response = await fetch('/api/referrals/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      await readJson<{ rewardPaise: number }>(response)
      const account = await fetchAccount()
      if (account) set(account)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not claim invite' }
    }
  },

  async createMarket(input) {
    try {
      const response = await fetch('/api/admin/markets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const body = await readJson<{ ok: boolean; marketId?: string }>(response)
      const marketPayload = await fetchMarkets()
      set({ markets: marketPayload.markets })
      return { ok: body.ok, error: body.ok ? undefined : 'The market could not be created' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not create market' }
    }
  },

  async resolveMarket(marketId, outcomeId) {
    try {
      const response = await fetch('/api/admin/markets/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketId, outcomeId }) })
      const body = await readJson<{ ok: boolean; error?: string }>(response)
      if (body.ok) {
        const marketPayload = await fetchMarkets()
        set({ markets: marketPayload.markets })
      }
      return body
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not resolve market' }
    }
  },

  async setMarketStatus(marketId, status) {
    try {
      const response = await fetch('/api/admin/markets/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketId, status }) })
      const body = await readJson<{ ok: boolean; error?: string }>(response)
      if (body.ok) {
        const marketPayload = await fetchMarkets()
        set({ markets: marketPayload.markets })
      }
      return body
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not update market' }
    }
  },

  async adminFetchTransactions(query = '') {
    set({ adminTransactionsLoading: true })
    try {
      const response = await fetch(`/api/admin/transactions?query=${encodeURIComponent(query)}`, { cache: 'no-store' })
      const body = await readJson<{ transactions: AdminTransaction[] }>(response)
      set({ adminTransactions: body.transactions, adminTransactionsLoading: false })
    } catch (error) {
      console.error('[store] admin transaction fetch failed', error)
      set({ adminTransactionsLoading: false })
    }
  },

  async adminRefundTransaction(transactionId, reason) {
    try {
      const response = await fetch('/api/admin/wallet/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId, reason }),
      })
      const body = await readJson<{ transactionId: string }>(response)
      set({ adminTransactions: get().adminTransactions.filter((t) => t.id !== transactionId) })
      return { ok: true, transactionId: body.transactionId }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not process refund' }
    }
  },

}))
