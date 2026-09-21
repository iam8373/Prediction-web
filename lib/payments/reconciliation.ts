import 'server-only'

import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db } from '@/lib/db'
import { ensurePaymentSchema } from '@/lib/db/payment-schema'
import {
  ledgerEntries,
  paymentIntents,
  paymentReconciliationFindings,
  paymentReconciliationRuns,
  wallets,
} from '@/lib/db/schema'
import { getPaymentConfig } from '@/lib/payments/config'
import { getProviderById } from '@/lib/payments/provider'
import { providerForPayment } from '@/lib/payments/service'
import {
  comparePaymentRecords,
  type PaymentStatus,
  type ReconciliationStatus,
} from '@/lib/payments/state-machine'
import type { ReconciliationFinding, ReconciliationRunSummary, WalletLedgerAudit } from '@/types'

/**
 * Payment reconciliation.
 *
 * Answers "does our internal payment state match the payment provider's state?"
 * and records every divergence as a finding. It NEVER corrects a mismatch by
 * guessing: an operator handles it (and the correction is audited).
 */

const RECONCILABLE_STATUSES: PaymentStatus[] = [
  'created',
  'pending',
  'processing',
  'verified',
  'completed',
  'refunded',
  'partially_refunded',
]

export interface ReconciliationOptions {
  providerId?: string
  actorUserId?: string
  limit?: number
  sinceDays?: number
}

export async function runPaymentReconciliation(options: ReconciliationOptions = {}): Promise<ReconciliationRunSummary> {
  await ensurePaymentSchema()
  const config = getPaymentConfig()
  const providerId = options.providerId?.trim().toLowerCase() || config.providerId
  // Reconcile against the credentials for the mode this deployment is actually
  // running in, so a sandbox run never compares test payments with live records.
  const runMode = config.effective === 'live' ? 'live' : 'sandbox'
  const provider = providerId === 'demo'
    ? getProviderById('demo')
    : getProviderById(providerId, runMode)
  if (!provider) throw new Error('RECONCILIATION_PROVIDER_UNAVAILABLE')

  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  const since = Date.now() - (options.sinceDays ?? 30) * 86_400_000
  const runId = `recon_${randomUUID()}`
  const startedAt = Date.now()

  await db.insert(paymentReconciliationRuns).values({
    id: runId,
    provider: provider.id,
    mode: provider.mode,
    status: 'running',
    startedAt,
    triggeredByUserId: options.actorUserId ?? null,
  })

  const findings: ReconciliationFinding[] = []
  let checked = 0
  let matched = 0

  const rows = await db
    .select()
    .from(paymentIntents)
    .where(and(
      eq(paymentIntents.provider, provider.id),
      gte(paymentIntents.createdAt, since),
      inArray(paymentIntents.status, RECONCILABLE_STATUSES),
    ))
    .orderBy(desc(paymentIntents.createdAt))
    .limit(limit)

  for (const intent of rows) {
    checked += 1
    // Each payment is reconciled through the provider adapter for ITS OWN mode.
    const intentProvider = providerForPayment(intent) ?? provider
    let providerRecord = null
    if (intent.providerPaymentId) {
      try {
        providerRecord = await intentProvider.fetchPayment(intent.providerPaymentId)
      } catch {
        providerRecord = null
      }
    }

    const comparison = comparePaymentRecords(
      { status: intent.status as PaymentStatus, amountPaise: intent.amountPaise, currency: intent.currency },
      providerRecord ? { status: providerRecord.status, amountPaise: providerRecord.amountPaise, currency: providerRecord.currency } : null,
    )

    if (comparison.status === 'matched') matched += 1

    const createdAt = Date.now()
    const findingId = `recon_finding_${randomUUID()}`
    await db
      .insert(paymentReconciliationFindings)
      .values({
        id: findingId,
        runId,
        provider: provider.id,
        paymentIntentId: intent.id,
        status: comparison.status,
        internalStatus: intent.status,
        providerStatus: providerRecord?.status ?? null,
        internalAmountPaise: intent.amountPaise,
        providerAmountPaise: providerRecord?.amountPaise ?? null,
        notes: comparison.notes || null,
        createdAt,
      })
      .onConflictDoNothing()

    if (comparison.status !== 'matched') {
      findings.push({
        id: findingId,
        runId,
        provider: provider.id,
        paymentIntentId: intent.id,
        status: comparison.status,
        internalStatus: intent.status as PaymentStatus,
        providerStatus: providerRecord?.status,
        internalAmountPaise: intent.amountPaise,
        providerAmountPaise: providerRecord?.amountPaise,
        notes: comparison.notes,
        createdAt,
      })
    }

    if (intent.reconciliationStatus !== comparison.status) {
      await db
        .update(paymentIntents)
        .set({ reconciliationStatus: comparison.status, updatedAt: Date.now() })
        .where(eq(paymentIntents.id, intent.id))
    }
  }

  // Provider records we have no internal payment for. Only possible when the
  // provider exposes a record listing capability.
  let notes = ''
  if (provider.capabilities.listPayments && provider.listPayments) {
    try {
      const providerRecords = await provider.listPayments({ since, limit: limit * 2 })
      for (const record of providerRecords) {
        const [known] = await db
          .select({ id: paymentIntents.id })
          .from(paymentIntents)
          .where(and(eq(paymentIntents.provider, provider.id), eq(paymentIntents.providerPaymentId, record.id)))
          .limit(1)
        if (known) continue
        const createdAt = Date.now()
        const findingId = `recon_finding_${randomUUID()}`
        await db
          .insert(paymentReconciliationFindings)
          .values({
            id: findingId,
            runId,
            provider: provider.id,
            paymentIntentId: `provider:${record.id}`,
            status: 'missing_internal_record' satisfies ReconciliationStatus,
            providerStatus: record.status,
            providerAmountPaise: record.amountPaise,
            notes: `The provider has ${record.direction} ${record.reference} (${record.amountPaise} paise) but we have no matching internal payment`,
            createdAt,
          })
          .onConflictDoNothing()
        findings.push({
          id: findingId,
          runId,
          provider: provider.id,
          paymentIntentId: `provider:${record.id}`,
          status: 'missing_internal_record',
          providerStatus: record.status,
          providerAmountPaise: record.amountPaise,
          notes: 'Provider record has no internal counterpart',
          createdAt,
        })
      }
    } catch (error) {
      // The run still completes; the missing-internal-record half is simply not
      // checked this time and that is recorded on the run.
      const message = error instanceof Error ? error.message : 'LIST_FAILED'
      notes = `Provider record listing failed: ${message}`.slice(0, 500)
    }
  }

  const finishedAt = Date.now()
  await db
    .update(paymentReconciliationRuns)
    .set({
      status: 'completed',
      checkedCount: checked,
      matchedCount: matched,
      mismatchCount: findings.length,
      notes: notes || null,
      finishedAt,
    })
    .where(eq(paymentReconciliationRuns.id, runId))

  await recordAudit({
    actorRole: options.actorUserId ? 'admin' : 'system',
    actorUserId: options.actorUserId,
    action: AUDIT_ACTIONS.reconciliationRun,
    entityType: 'paymentReconciliationRun',
    entityId: runId,
    summary: `Reconciled ${checked} ${provider.id} payments: ${matched} matched, ${findings.length} needing review`,
    metadata: { provider: provider.id, checked, matched, mismatches: findings.length },
  })

  return {
    id: runId,
    provider: provider.id,
    mode: provider.mode,
    status: 'completed',
    checkedCount: checked,
    matchedCount: matched,
    mismatchCount: findings.length,
    notes: notes || undefined,
    startedAt,
    finishedAt,
    findings,
  }
}

/**
 * Accounting check for one account: does the wallet hold exactly what the
 * ledger says it should?
 *
 *   completed ledger movements + reserved (pending) movements == available + locked
 *
 * A withdrawal reservation is booked as a `pending` debit, so it is part of the
 * expected total while the money sits in the locked bucket; confirming it moves
 * the entry to `completed`, releasing it voids the entry. That is why both
 * statuses are summed and why an admin cancellation of a hold books no
 * compensating credit (§ applyRefundSettlement).
 *
 * `bonusPaise` is reported separately because promotional credit is not a
 * payment movement. This is READ ONLY: a difference is reported with its
 * components for investigation — it is never compensated with an arbitrary
 * balance adjustment.
 */
export async function auditWalletAgainstLedger(userId: string): Promise<WalletLedgerAudit> {
  await ensurePaymentSchema()
  const [wallet] = await db
    .select({ availablePaise: wallets.availablePaise, lockedPaise: wallets.lockedPaise, bonusPaise: wallets.bonusPaise })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1)
  if (!wallet) throw new Error('ACCOUNT_NOT_READY')

  const [totals] = await db
    .select({
      // Money movements in the spendable/locked buckets: deposits, withdrawals
      // (and their holds), refunds, trades, payouts and fees.
      completedPaise: sql<number>`coalesce(sum(case when ${ledgerEntries.status} = 'completed' and ${ledgerEntries.type} <> 'bonus' then ${ledgerEntries.amountPaise} else 0 end), 0)::bigint`,
      pendingPaise: sql<number>`coalesce(sum(case when ${ledgerEntries.status} = 'pending' then ${ledgerEntries.amountPaise} else 0 end), 0)::bigint`,
      // Promotional credit lives in its own wallet bucket, so it is reconciled
      // separately instead of being folded into the spendable total.
      bonusPaise: sql<number>`coalesce(sum(case when ${ledgerEntries.status} = 'completed' and ${ledgerEntries.type} = 'bonus' then ${ledgerEntries.amountPaise} else 0 end), 0)::bigint`,
      entryCount: sql<number>`count(*)::int`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.userId, userId))

  const completedPaise = Number(totals?.completedPaise ?? 0)
  const pendingPaise = Number(totals?.pendingPaise ?? 0)
  const ledgerBonusPaise = Number(totals?.bonusPaise ?? 0)
  const expectedPaise = completedPaise + pendingPaise
  const actualPaise = wallet.availablePaise + wallet.lockedPaise
  const bonusDifference = wallet.bonusPaise - ledgerBonusPaise

  return {
    userId,
    entryCount: totals?.entryCount ?? 0,
    ledgerCompletedPaise: completedPaise,
    ledgerPendingPaise: pendingPaise,
    expectedTotalPaise: expectedPaise,
    walletAvailablePaise: wallet.availablePaise,
    walletLockedPaise: wallet.lockedPaise,
    walletBonusPaise: wallet.bonusPaise,
    ledgerBonusPaise,
    actualTotalPaise: actualPaise,
    differencePaise: actualPaise - expectedPaise,
    bonusDifferencePaise: bonusDifference,
    status: actualPaise === expectedPaise && bonusDifference === 0 ? 'matched' : 'difference',
  }
}

export async function listReconciliationRuns(limit = 10) {
  await ensurePaymentSchema()
  return db.select().from(paymentReconciliationRuns).orderBy(desc(paymentReconciliationRuns.startedAt)).limit(limit)
}

/** Findings needing review by default: everything except clean matches. */
export async function listReconciliationFindings(input: { includeMatched?: boolean; limit?: number } = {}) {
  await ensurePaymentSchema()
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const rows = input.includeMatched
    ? await db
      .select()
      .from(paymentReconciliationFindings)
      .orderBy(desc(paymentReconciliationFindings.createdAt))
      .limit(limit)
    : await db
      .select()
      .from(paymentReconciliationFindings)
      .where(ne(paymentReconciliationFindings.status, 'matched'))
      .orderBy(desc(paymentReconciliationFindings.createdAt))
      .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    provider: row.provider,
    paymentIntentId: row.paymentIntentId,
    status: row.status as ReconciliationStatus,
    internalStatus: (row.internalStatus ?? undefined) as PaymentStatus | undefined,
    providerStatus: row.providerStatus as ReconciliationFinding['providerStatus'],
    internalAmountPaise: row.internalAmountPaise ?? undefined,
    providerAmountPaise: row.providerAmountPaise ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  })) satisfies ReconciliationFinding[]
}

/**
 * Deployment-wide accounting invariant sweep (read only).
 *
 * The per-account `auditWalletAgainstLedger` answers "is THIS wallet right?". A
 * launch needs the same question answered for every account plus the cross-table
 * invariants that a per-wallet check cannot see:
 *
 *   wallet(available + locked) == ledger(completed + pending)   [per account]
 *   wallet.bonus              == ledger(bonus, completed)       [per account]
 *   available, locked, bonus  >= 0                              [per account]
 *   settled payment           => exactly one transaction row
 *   completed transaction     => a ledger entry with the same reference
 *   refund payment            => a parent payment
 *
 * It NEVER repairs anything: a difference is returned so a human can investigate
 * with the audited correction path. The wallet equation below is the set-based
 * form of `auditWalletAgainstLedger`; a database test asserts both agree for the
 * same account so the two can never drift apart silently.
 */
export interface AccountingIntegrityAudit {
  checkedAt: number
  status: 'clean' | 'findings' | 'incomplete'
  /** Invariants that were evaluated successfully. */
  checked: string[]
  /** Invariants that could not be evaluated (never reported as passing). */
  notChecked: string[]
  walletCount: number
  transactionCount: number
  paymentCount: number
  /** How many accounts fail the wallet equation (detail rows are capped at 50). */
  walletDifferenceCount: number
  /**
   * Split of the failing accounts by direction, which is what an operator has to
   * act on: `unexplained` accounts hold MORE than the ledger explains (a credit
   * with no accounting record — could be seed data, could be money created),
   * `shortfall` accounts hold less (money left without a booking).
   */
  walletDifferenceSplit: { unexplainedAccounts: number; shortfallAccounts: number }
  /** Accounts whose wallet does not match its ledger, worst first (max 50). */
  walletDifferences: Array<{
    userId: string
    availablePaise: number
    lockedPaise: number
    bonusPaise: number
    walletDifferencePaise: number
    bonusDifferencePaise: number
    /**
     * Ledger entries behind this account. 0 means the balance was never booked
     * through accounting at all — seed/fixture data rather than a drifted
     * posting, which is the distinction an operator needs before launch.
     */
    ledgerEntryCount: number
  }>
  counts: {
    settledPaymentsWithoutTransaction: number
    /** Payments the provider confirmed but that are not yet settled (recoverable). */
    awaitingSettlement: number
    completedTransactionsWithoutLedger: number
    refundPaymentsWithoutParent: number
  }
}

// Single-line SQL on purpose: the invariant has to be readable in a query log.
const WALLET_LEDGER_CTE =
  "with ledger_totals as (select user_id, coalesce(sum(case when status = 'completed' and type <> 'bonus' then amount_paise else 0 end), 0) as completed, coalesce(sum(case when status = 'pending' then amount_paise else 0 end), 0) as pending, coalesce(sum(case when status = 'completed' and type = 'bonus' then amount_paise else 0 end), 0) as bonus from ledger_entry group by user_id)"
const WALLET_LEDGER_JOIN = ' from wallet w left join ledger_totals l on l.user_id = w.user_id'
const WALLET_LEDGER_PREDICATE = " where ((w.available_paise + w.locked_paise) <> (coalesce(l.completed, 0) + coalesce(l.pending, 0))) or (w.bonus_paise <> coalesce(l.bonus, 0)) or w.available_paise < 0 or w.locked_paise < 0 or w.bonus_paise < 0"
const WALLET_LEDGER_SWEEP_SQL =
  WALLET_LEDGER_CTE +
  ' select w.user_id as user_id, w.available_paise as available_paise, w.locked_paise as locked_paise, w.bonus_paise as bonus_paise, ((w.available_paise + w.locked_paise) - (coalesce(l.completed, 0) + coalesce(l.pending, 0))) as wallet_difference, (w.bonus_paise - coalesce(l.bonus, 0)) as bonus_difference, (select count(*)::int from ledger_entry le where le.user_id = w.user_id) as ledger_entry_count' +
  WALLET_LEDGER_JOIN +
  WALLET_LEDGER_PREDICATE +
  ' order by greatest(abs((w.available_paise + w.locked_paise) - (coalesce(l.completed, 0) + coalesce(l.pending, 0))), abs(w.bonus_paise - coalesce(l.bonus, 0))) desc limit 50'
const WALLET_LEDGER_COUNT_SQL = WALLET_LEDGER_CTE + ' select count(*)::int as count' + WALLET_LEDGER_JOIN + WALLET_LEDGER_PREDICATE
const WALLET_LEDGER_SPLIT_SQL =
  WALLET_LEDGER_CTE +
  ' select count(*) filter (where ((w.available_paise + w.locked_paise) - (coalesce(l.completed, 0) + coalesce(l.pending, 0))) + (w.bonus_paise - coalesce(l.bonus, 0)) > 0)::int as unexplained, count(*) filter (where ((w.available_paise + w.locked_paise) - (coalesce(l.completed, 0) + coalesce(l.pending, 0))) + (w.bonus_paise - coalesce(l.bonus, 0)) <= 0)::int as shortfall' +
  WALLET_LEDGER_JOIN +
  WALLET_LEDGER_PREDICATE

async function scalarCount(label: string, query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(query)
  const rows = result.rows as Array<{ count: number | string }>
  const value = rows[0]?.count
  if (value === undefined) throw new Error(`${label} returned no row`)
  return Number(value)
}

export async function auditAccountingIntegrity(): Promise<AccountingIntegrityAudit> {
  await ensurePaymentSchema()

  const checked: string[] = []
  const notChecked: string[] = []
  const walletDifferences: AccountingIntegrityAudit['walletDifferences'] = []
  const counts: AccountingIntegrityAudit['counts'] = {
    settledPaymentsWithoutTransaction: 0,
    awaitingSettlement: 0,
    completedTransactionsWithoutLedger: 0,
    refundPaymentsWithoutParent: 0,
  }
  let walletCount = 0
  let transactionCount = 0
  let paymentCount = 0
  let walletDifferenceCount = 0
  const walletDifferenceSplit = { unexplainedAccounts: 0, shortfallAccounts: 0 }

  try {
    const result = await db.execute(sql.raw(WALLET_LEDGER_SWEEP_SQL))
    for (const row of result.rows as Array<Record<string, unknown>>) {
      walletDifferences.push({
        userId: String(row.user_id),
        availablePaise: Number(row.available_paise),
        lockedPaise: Number(row.locked_paise),
        bonusPaise: Number(row.bonus_paise),
        walletDifferencePaise: Number(row.wallet_difference),
        bonusDifferencePaise: Number(row.bonus_difference),
        ledgerEntryCount: Number(row.ledger_entry_count),
      })
    }
    walletDifferenceCount = await scalarCount('wallet_difference_count', sql.raw(WALLET_LEDGER_COUNT_SQL))
    const split = await db.execute(sql.raw(WALLET_LEDGER_SPLIT_SQL))
    const splitRow = (split.rows as Array<Record<string, unknown>>)[0]
    walletDifferenceSplit.unexplainedAccounts = Number(splitRow?.unexplained ?? 0)
    walletDifferenceSplit.shortfallAccounts = Number(splitRow?.shortfall ?? 0)
    checked.push('wallet_ledger_equation')
  } catch {
    notChecked.push('wallet_ledger_equation')
  }

  const countChecks: Array<[keyof AccountingIntegrityAudit['counts'], string, ReturnType<typeof sql>]> = [
    [
      'settledPaymentsWithoutTransaction',
      'settled_payments_have_transaction',
      sql`select count(*)::int as count from payment_intent where status in ('completed', 'refunded', 'partially_refunded') and transaction_id is null`,
    ],
    [
      'awaitingSettlement',
      'provider_verified_but_unsettled',
      sql`select count(*)::int as count from payment_intent where status = 'verified'`,
    ],
    [
      'completedTransactionsWithoutLedger',
      'completed_transactions_have_ledger',
      sql`select count(*)::int as count from transaction t left join ledger_entry l on l.reference = t.reference where t.status = 'completed' and l.id is null`,
    ],
    [
      'refundPaymentsWithoutParent',
      'refunds_reference_a_payment',
      sql`select count(*)::int as count from payment_intent where direction = 'refund' and parent_payment_id is null`,
    ],
  ]

  for (const [key, label, query] of countChecks) {
    try {
      counts[key] = await scalarCount(label, query)
      checked.push(label)
    } catch {
      notChecked.push(label)
    }
  }

  try {
    walletCount = await scalarCount('wallet_count', sql`select count(*)::int as count from wallet`)
    transactionCount = await scalarCount('transaction_count', sql`select count(*)::int as count from transaction`)
    paymentCount = await scalarCount('payment_count', sql`select count(*)::int as count from payment_intent`)
  } catch {
    notChecked.push('table_counts')
  }

  const hasFindings =
    walletDifferenceCount > 0 ||
    counts.settledPaymentsWithoutTransaction > 0 ||
    counts.completedTransactionsWithoutLedger > 0 ||
    counts.refundPaymentsWithoutParent > 0

  return {
    checkedAt: Date.now(),
    status: notChecked.length > 0 ? 'incomplete' : hasFindings ? 'findings' : 'clean',
    checked,
    notChecked,
    walletCount,
    transactionCount,
    paymentCount,
    walletDifferenceCount,
    walletDifferenceSplit,
    walletDifferences,
    counts,
  }
}
