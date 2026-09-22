import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'

import {
  bootstrapDatabase,
  ensureDatabaseSchema,
  schemaAlterStatements,
  schemaStatements,
  schemaTableNames,
} from '@/lib/db/bootstrap'
import * as schema from '@/lib/db/schema'
import { ensurePaymentSchema } from '@/lib/db/payment-schema'
import {
  closePool,
  databaseUrl,
  indexNames,
  isDisposableDatabase,
  rawSql,
  resetDatabase,
  schemaDescription,
  tableNames,
} from './harness.ts'

const url = databaseUrl()
const skip = url ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'

/** Payment tables that must exist after a bootstrap. */
const PAYMENT_TABLES = [
  'payment_intent',
  'payment_webhook_event',
  'payment_reconciliation_run',
  'payment_reconciliation_finding',
  'payment_account',
  'audit_log',
]

/** Indexes that are the database-level guarantee behind payment idempotency. */
const REQUIRED_UNIQUE_INDEXES: Array<[string, string]> = [
  ['payment_intent', 'payment_intent_request_idx'],
  ['payment_intent', 'payment_intent_provider_payment_idx'],
  ['payment_webhook_event', 'payment_webhook_event_unique_idx'],
  ['payment_reconciliation_finding', 'payment_reconciliation_finding_run_idx'],
  ['ledger_entry', 'ledger_reference_idx'],
  ['transaction', 'transaction_reference_idx'],
  ['notification', 'notification_user_event_idx'],
]

/** Distinct table configs — the schema module exports each table twice (alias). */
function drizzleTables() {
  const byName = new Map<string, ReturnType<typeof getTableConfig>>()
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    if (!byName.has(config.name)) byName.set(config.name, config)
  }
  return [...byName.values()]
}

const DISTINCT_TABLES = schemaTableNames()

function normalizeType(dataType: string) {
  if (dataType === 'timestamp without time zone') return 'timestamp'
  if (dataType === 'bigint') return 'bigint'
  return dataType
}

describe('PostgreSQL schema bootstrap', () => {
  test('refuses to run against a database that is not clearly a test database', () => {
    assert.equal(isDisposableDatabase(), true, `DATABASE_URL must point at a *test* database, got "${databaseUrl()}"`)
  })

  test('bootstraps every table from an empty database', { skip }, async () => {
    await resetDatabase()
    const tables = await tableNames()
    assert.deepEqual(
      tables,
      DISTINCT_TABLES, 
      'the bootstrap must create exactly the tables declared in lib/db/schema.ts',
    )
    for (const table of PAYMENT_TABLES) {
      assert.ok(tables.includes(table), `payment table ${table} is missing after bootstrap`)
    }
  })

  test('re-running the bootstrap is idempotent', { skip }, async () => {
    await resetDatabase()
    const before = await tableNames()
    const columnsBefore = (await rawSql<{ count: string }>(
      "select count(*)::text as count from information_schema.columns where table_schema = 'public'",
    ))[0]?.count

    // Same statements, three more times — must be a no-op, not an error.
    await ensureDatabaseSchema()
    await ensurePaymentSchema()
    await ensureDatabaseSchema()

    assert.deepEqual(await tableNames(), before)
    const columnsAfter = (await rawSql<{ count: string }>(
      "select count(*)::text as count from information_schema.columns where table_schema = 'public'",
    ))[0]?.count
    assert.equal(columnsAfter, columnsBefore, 'a repeated bootstrap must not add or remove columns')
  })

  test('a column added to an existing table reaches a database that predates it', { skip }, async () => {
    await resetDatabase()

    // Simulate a deployment created before the column existed: the table is
    // present and simply lacks it, which is exactly the case `create table if
    // not exists` cannot fix on its own.
    const target = schemaAlterStatements()[0]
    assert.ok(target, 'at least one additive statement is declared')
    const column = /add column if not exists "([^"]+)"/.exec(target)?.[1]
    assert.ok(column, 'the additive statement names a column')

    await rawSql('alter table "market" drop column "video_id"')
    const dropped = await schemaDescription('market')
    assert.ok(!dropped.some((entry) => entry.column_name === 'video_id'), 'the column is gone before the migration runs')

    await bootstrapDatabase()

    const restored = await schemaDescription('market')
    assert.ok(restored.some((entry) => entry.column_name === column), 'the bootstrap adds the missing column')
  })

  test('initializing while empty statements exist for every table is stable', { skip }, async () => {
    const statements = schemaStatements()
    assert.ok(statements.length >= DISTINCT_TABLES.length)
    for (const statement of statements) {
      assert.match(statement, /^create (table|unique index|index) if not exists/i, `not idempotent: ${statement.slice(0, 60)}`)
    }
  })

  test('live schema matches the Drizzle table definitions column by column', { skip }, async () => {
    await resetDatabase()
    for (const config of drizzleTables()) {
      const live = await schemaDescription(config.name)
      assert.equal(
        live.length,
        config.columns.length,
        `${config.name}: expected ${config.columns.length} columns, found ${live.length}`,
      )
      config.columns.forEach((column, index) => {
        const actual = live[index]
        assert.equal(actual.column_name, column.name, `${config.name} column ${index} name mismatch`)
        assert.equal(
          normalizeType(actual.data_type),
          normalizeType(column.getSQLType()),
          `${config.name}.${column.name} type mismatch`,
        )
        assert.equal(
          actual.is_nullable,
          column.notNull ? 'NO' : 'YES',
          `${config.name}.${column.name} nullability mismatch`,
        )
      })
    }
  })

  test('primary keys and idempotency indexes exist on the live database', { skip }, async () => {
    await resetDatabase()
    for (const config of drizzleTables()) {
      const primary = config.columns.filter((column) => column.primary).map((column) => column.name)
      const liveIndexes = await indexNames(config.name)
      for (const index of config.indexes) {
        assert.ok(
          liveIndexes.includes(index.config.name as string),
          `${config.name}: index ${index.config.name} missing`,
        )
      }
      if (primary.length === 0) continue
      const keys = await rawSql<{ column_name: string }>(
        `select kcu.column_name
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu
             on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
          where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'PRIMARY KEY'
          order by kcu.ordinal_position`,
        [config.name],
      )
      assert.deepEqual(keys.map((row) => row.column_name), primary, `${config.name}: primary key mismatch`)
    }
  })

  test('the unique indexes that make retries harmless are unique in the database', { skip }, async () => {
    await resetDatabase()
    for (const [table, index] of REQUIRED_UNIQUE_INDEXES) {
      const rows = await rawSql<{ is_unique: boolean }>(
        'select i.indisunique as is_unique from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = $1',
        [index],
      )
      assert.equal(rows[0]?.is_unique, true, `${table}.${index} must be a UNIQUE index`)
    }
  })

  test('application tables round-trip after bootstrap (existing behaviour preserved)', { skip }, async () => {
    await resetDatabase()
    await rawSql("insert into \"user\" (id, name, email) values ($1, $2, $3)", ['user_roundtrip', 'Round Trip', 'rt@test.local'])
    await rawSql('insert into wallet (user_id, available_paise) values ($1, $2)', ['user_roundtrip', 12_345])
    await rawSql("insert into \"transaction\" (id, user_id, reference, type, amount_paise, status, description, created_at) values ($1,$2,$3,'deposit',$4,'completed','seed',$5)", [
      'txn_roundtrip',
      'user_roundtrip',
      'REF-ROUNDTRIP',
      12_345,
      Date.now(),
    ])
    const [wallet] = await rawSql<{ available_paise: string }>('select available_paise from wallet where user_id = $1', ['user_roundtrip'])
    assert.equal(Number(wallet.available_paise), 12_345)
  })
})

after(async () => {
  await closePool()
})
