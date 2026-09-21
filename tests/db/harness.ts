import 'server-only'

/**
 * PostgreSQL E2E harness.
 *
 * This module gives the DB-backed suites a disposable, deterministic PostgreSQL
 * fixture built on top of the application's OWN modules
 * (`@/lib/db/bootstrap`, `@/lib/db`, the payment service), so the tests exercise
 * the same SQL, constraints and transactions that production runs.
 *
 * Safety: `resetDatabase()` refuses to touch anything whose database name does
 * not look like a test database. It can never run against production.
 */

import { eq, sql } from 'drizzle-orm'
import type { QueryResultRow } from 'pg'

import { db, pool } from '@/lib/db'
import { bootstrapDatabase } from '@/lib/db/bootstrap'
import { resetSecuritySchemaCache } from '@/lib/db/security-schema'
import { ledgerEntries, notifications, paymentAccounts, paymentIntents, transactions, users, wallets } from '@/lib/db/schema'

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || undefined
}

export function databaseName(): string {
  const url = databaseUrl()
  if (!url) return ''
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
}

/** Guard so an accidental production URL can never be wiped by the suite. */
export function isDisposableDatabase(): boolean {
  const name = databaseName()
  return /(?:^|[_-])test(?:[_-]|$)/i.test(name) || name.toLowerCase().endsWith('_test')
}

export async function resetDatabase() {
  if (!isDisposableDatabase()) {
    throw new Error(
      `Refusing to reset database "${databaseName() || '(unknown)'}": the DB E2E suite only runs against a database whose name contains "test".`,
    )
  }
  await pool.query('drop schema if exists public cascade')
  await pool.query('create schema public')
  // The schema (and therefore the triggers) just disappeared, so any memoized
  // "already ensured" state from this process is no longer true.
  resetSecuritySchemaCache()
  // Deliberately the un-memoized bootstrap: the memoized helpers already
  // believe the schema exists, which would leave this database empty.
  await bootstrapDatabase()
}

export async function bootstrapRepeatedly(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await bootstrapDatabase()
  }
}

export async function closePool() {
  await pool.end()
}

export interface TestUser {
  userId: string
  phone: string
}

let userCounter = 0

/** Creates a user + wallet directly, so balances are exact and not seeded by hand. */
export async function createTestUser(input: {
  availablePaise?: number
  lockedPaise?: number
  bonusPaise?: number
  isAdmin?: boolean
  kycStatus?: 'unverified' | 'pending' | 'verified' | 'rejected'
  accountStatus?: 'active' | 'restricted' | 'blocked'
  liveEligible?: boolean
  jurisdiction?: string
} = {}): Promise<TestUser> {
  userCounter += 1
  const suffix = `${process.pid}${userCounter}${Math.floor(Math.random() * 1e6)}`
  const phone = `90000${String(userCounter).padStart(5, '0')}`
  const userId = `user_test_${suffix}`

  await db.insert(users).values({
    id: userId,
    name: `Test Trader ${userCounter}`,
    email: `${suffix}@test.predik.local`,
    phoneNumber: phone,
    phoneNumberVerified: true,
    isAdmin: input.isAdmin ?? false,
  })
  await db.insert(wallets).values({
    userId,
    availablePaise: input.availablePaise ?? 0,
    lockedPaise: input.lockedPaise ?? 0,
    bonusPaise: input.bonusPaise ?? 0,
  })
  if (input.kycStatus || input.accountStatus || input.jurisdiction || input.liveEligible !== undefined) {
    await db.insert(paymentAccounts).values({
      userId,
      status: input.accountStatus ?? 'active',
      kycStatus: input.kycStatus ?? 'unverified',
      liveEligible: input.liveEligible ?? false,
      jurisdiction: input.jurisdiction ?? null,
    })
  }
  return { userId, phone }
}

export async function setWallet(userId: string, input: { availablePaise?: number; lockedPaise?: number; bonusPaise?: number }) {
  await db.update(wallets).set({ ...input, updatedAt: new Date() }).where(eq(wallets.userId, userId))
}

export async function readWallet(userId: string) {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1)
  if (!wallet) throw new Error(`wallet missing for ${userId}`)
  return wallet
}

export async function readPayment(paymentId: string) {
  const [row] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, paymentId)).limit(1)
  return row ?? null
}

export async function paymentRowsForUser(userId: string) {
  return db.select().from(paymentIntents).where(eq(paymentIntents.userId, userId))
}

export async function transactionsForUser(userId: string) {
  return db.select().from(transactions).where(eq(transactions.userId, userId))
}

export async function ledgerForUser(userId: string) {
  return db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, userId))
}

export async function notificationsForUser(userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId))
}

export async function auditRowsFor(entityId: string) {
  const result = await pool.query<{ action: string; summary: string; actor_role: string; entity_id: string }>(
    'select action, summary, actor_role, entity_id from audit_log where entity_id = $1 or entity_id like $2 order by created_at asc',
    [entityId, `%${entityId}%`],
  )
  return result.rows
}

export async function webhookEventsFor(paymentId: string) {
  const result = await pool.query<{ provider_event_id: string; status: string; event_type: string }>(
    'select provider_event_id, status, event_type from payment_webhook_event where payment_intent_id = $1 order by received_at asc',
    [paymentId],
  )
  return result.rows
}

export async function countRows(table: string, where?: { column: string; value: string }) {
  const clause = where ? ` where ${where.column} = $1` : ''
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count from ${table}${clause}`,
    where ? [where.value] : [],
  )
  return Number(result.rows[0]?.count ?? '0')
}

export async function tableNames() {
  const result = await pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
  )
  return result.rows.map((row) => row.table_name)
}

export async function schemaDescription(table: string) {
  const result = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
    'select column_name, data_type, is_nullable from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position',
    ['public', table],
  )
  return result.rows
}

export async function indexNames(table: string) {
  const result = await pool.query<{ indexname: string }>(
    'select indexname from pg_indexes where schemaname = $1 and tablename = $2 order by indexname',
    ['public', table],
  )
  return result.rows.map((row) => row.indexname)
}

/** Total money referenced by the ledger, used for accounting assertions. */
export async function ledgerTotal(userId: string) {
  const result = await pool.query<{ completed: string; pending: string }>(
    `select
       coalesce(sum(case when status = 'completed' and type <> 'bonus' then amount_paise else 0 end), 0)::text as completed,
       coalesce(sum(case when status = 'pending' then amount_paise else 0 end), 0)::text as pending
     from ledger_entry where user_id = $1`,
    [userId],
  )
  const row = result.rows[0]
  return { completedPaise: Number(row?.completed ?? '0'), pendingPaise: Number(row?.pending ?? '0') }
}

export async function transactionById(id: string) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1)
  return row ?? null
}

export async function notificationCount(userId: string) {
  return countRows('notification', { column: 'user_id', value: userId })
}

/** Truncates every table the payment suite touches, keeping the schema. */
export async function truncateAll() {
  const tables = await tableNames()
  if (tables.length === 0) return
  await pool.query(`truncate table ${tables.map((table) => `"${table}"`).join(', ')} cascade`)
}

export const rawSql = async <T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) => {
  const result = await pool.query<T>(text, values as never[])
  return result.rows
}

export { db, sql }
