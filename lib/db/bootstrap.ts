import 'server-only'

import { is, sql } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'

import { db } from '@/lib/db'
import { ensurePaymentSchema, paymentSchemaStatements } from '@/lib/db/payment-schema'
import { ensureSecuritySchema, securitySchemaStatements } from '@/lib/db/security-schema'
import * as schema from '@/lib/db/schema'

/**
 * Core (non-payment) schema bootstrap.
 *
 * The catalogue/wallet/auth tables were originally provisioned outside this
 * repository, which meant a fresh database could not be built from the source
 * tree at all — only the Phase 9 payment tables had DDL (`payment-schema.ts`).
 * This module closes that gap with the same idempotent approach: `create table
 * if not exists` / `create index if not exists` statements, safe to run
 * repeatedly.
 *
 * The DDL is DERIVED from `lib/db/schema.ts` through Drizzle's own table
 * metadata instead of being hand-copied, so it cannot drift from the schema the
 * application actually queries. Re-running it is a no-op on an existing
 * database and never drops or alters anything.
 */

type TableMetadata = ReturnType<typeof getTableConfig>

/**
 * Distinct tables declared in `lib/db/schema.ts`.
 *
 * The schema module exports each table twice (camelCase declaration + the
 * legacy short alias), so the tables are de-duplicated by their SQL name.
 */
function schemaTables(): TableMetadata[] {
  const byName = new Map<string, TableMetadata>()
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue
    const table = getTableConfig(value)
    if (!byName.has(table.name)) byName.set(table.name, table)
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function quote(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`
}

/** Renders the SQL fragments Drizzle stores for `defaultNow()`-style defaults. */
function renderSqlFragment(fragment: unknown): string {
  if (typeof fragment === 'string') return fragment
  if (typeof fragment === 'number' || typeof fragment === 'bigint') return String(fragment)
  if (typeof fragment === 'boolean') return fragment ? 'true' : 'false'
  if (fragment && typeof fragment === 'object') {
    const candidate = fragment as { value?: unknown; queryChunks?: unknown[]; name?: string }
    if (Array.isArray(candidate.queryChunks)) {
      return candidate.queryChunks.map(renderSqlFragment).join('')
    }
    if (Array.isArray(candidate.value)) {
      return candidate.value.map(renderSqlFragment).join('')
    }
    if (typeof candidate.name === 'string') return quote(candidate.name)
  }
  throw new Error(`Cannot render SQL fragment for schema bootstrap: ${String(fragment)}`)
}

function renderDefault(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value && typeof value === 'object') return renderSqlFragment(value)
  throw new Error(`Cannot render schema default: ${String(value)}`)
}

function renderColumn(column: TableMetadata['columns'][number]) {
  const parts = [quote(column.name), column.getSQLType()]
  if (column.primary) parts.push('primary key')
  if (column.notNull) parts.push('not null')
  if (column.hasDefault) parts.push(`default ${renderDefault(column.default)}`)
  return parts.join(' ')
}

function renderIndex(table: string, index: TableMetadata['indexes'][number]) {
  const columns = index.config.columns.map((column) => {
    const candidate = column as { name?: string }
    if (typeof candidate.name === 'string') return quote(candidate.name)
    // Expression indexes would need the raw SQL; the schema does not use any.
    throw new Error(`Cannot render expression index for schema bootstrap: ${index.config.name}`)
  })
  const unique = index.config.unique ? 'unique ' : ''
  return `create ${unique}index if not exists ${quote(index.config.name ?? `${table}_index`)} on ${quote(table)} (${columns.join(', ')})`
}

/**
 * Every statement needed to bring an empty PostgreSQL database up to the
 * current application schema. Pure — no database connection is made.
 */
export function schemaStatements(): string[] {
  const statements: string[] = []

  for (const table of schemaTables()) {
    const columns = table.columns.map(renderColumn)

    // Composite primary keys are declared on the table in Drizzle; mirror them
    // as a table constraint so the bootstrap stays exact.
    for (const primaryKey of table.primaryKeys) {
      const names = primaryKey.columns.map((column) => quote(column.name))
      statements.push('')
      columns.push(`primary key (${names.join(', ')})`)
    }

    statements.push(`create table if not exists ${quote(table.name)} (\n  ${columns.join(',\n  ')}\n)`)
    for (const index of table.indexes) {
      statements.push(renderIndex(table.name, index))
    }
  }

  return statements.filter((statement) => statement.length > 0)
}

/** Table names this bootstrap owns, for reporting and verification. */
export function schemaTableNames(): string[] {
  return schemaTables().map((table) => table.name)
}

let coreSchemaPromise: Promise<void> | null = null

/**
 * Creates the core tables if they are missing. Memoized per process, and safe
 * to call concurrently. Requires DDL rights on the database — the same
 * requirement the Phase 9 payment tables already impose.
 */
export function ensureCoreSchema(): Promise<void> {
  coreSchemaPromise ??= runStatements(schemaStatements()).catch((error) => {
    coreSchemaPromise = null
    throw error
  })
  return coreSchemaPromise
}

/**
 * Core tables + the Phase 9 payment tables + the Phase 10 security objects
 * (rate-limit counters and the accounting immutability triggers), in one
 * idempotent step.
 */
export async function ensureDatabaseSchema(): Promise<void> {
  await ensureCoreSchema()
  await ensurePaymentSchema()
  await ensureSecuritySchema()
}

/**
 * Runs the whole bootstrap WITHOUT the per-process memoization.
 *
 * Used by `pnpm db:bootstrap` and by test suites that recreate the schema, where
 * relying on a cached "already ensured" flag would silently leave the database
 * empty.
 */
export async function bootstrapDatabase(): Promise<number> {
  // Order matters: the security statements install triggers ON the accounting
  // tables, so those tables must be created first.
  const statements = [...schemaStatements(), ...paymentSchemaStatements(), ...securitySchemaStatements()]
  await runStatements(statements)
  return statements.length
}

async function runStatements(statements: string[]) {
  for (const statement of statements) {
    await db.execute(sql.raw(statement))
  }
}
