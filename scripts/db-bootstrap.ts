/**
 * Idempotent database bootstrap: creates every table, index and trigger the
 * application needs if it is missing.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm db:bootstrap
 *
 * Safe to run repeatedly and safe on an existing database: it only ever issues
 * `create table if not exists` / `create index if not exists`. It never drops,
 * truncates or rewrites data, and it prints what it did.
 */

import { bootstrapDatabase, schemaTableNames } from '@/lib/db/bootstrap'
import { pool } from '@/lib/db'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Nothing to do.')
    process.exitCode = 1
    return
  }

  const expected = schemaTableNames()
  const statements = await bootstrapDatabase()

  const { rows } = await pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
  )
  const present = rows.map((row) => row.table_name)

  console.log(`schema bootstrap complete: ${statements} statements executed, ${present.length} tables present`)
  console.log(`core tables expected: ${expected.length}`)
  const missing = expected.filter((table) => !present.includes(table))
  if (missing.length > 0) {
    console.error(`missing tables: ${missing.join(', ')}`)
    process.exitCode = 1
  }
  await pool.end()
}

main().catch(async (error) => {
  console.error('schema bootstrap failed:', error instanceof Error ? error.message : error)
  await pool.end().catch(() => undefined)
  process.exitCode = 1
})
