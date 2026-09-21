import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'

/**
 * Phase 10 security DDL.
 *
 * Two things live here:
 *
 *  1. `rate_limit_counter` — shared, server-side abuse protection (see
 *     `lib/security/rate-limit.ts`). Same pattern as the payment tables: this
 *     project has no migration runner, so every table is created by idempotent
 *     `create ... if not exists` DDL before its first use.
 *
 *  2. Ledger/transaction immutability triggers — the accounting record is
 *     append-only. Application code legitimately moves a row's `status`
 *     (`pending -> completed/failed`) as a hold settles or is released, but the
 *     money-bearing columns (`user_id`, `amount_paise`, `reference`, `type`,
 *     `market_id`, `created_at`) and `delete` are refused by the database
 *     itself. That makes "silently rewrite history" impossible even for a buggy
 *     write, and forces corrections through compensating entries.
 *
 * `DATABASE_SCHEMA_BOOTSTRAP=off` disables both, so a deployment whose runtime
 * role intentionally has no DDL rights can run `pnpm db:bootstrap` once as the
 * schema owner and then run as a least-privilege role.
 */

const TABLE_STATEMENTS = [
  `create table if not exists rate_limit_counter (
    id text primary key,
    bucket text not null,
    key_hash text not null,
    window_start bigint not null,
    count integer not null default 0,
    expires_at bigint not null
  )`,
  `create index if not exists rate_limit_bucket_key_idx on rate_limit_counter (bucket, key_hash, window_start)`,
  `create index if not exists rate_limit_expiry_idx on rate_limit_counter (expires_at)`,
] as const

const IMMUTABILITY_STATEMENTS = [
  `create or replace function predik_accounting_row_immutable() returns trigger as $$
   begin
     if tg_op = 'DELETE' then
       raise exception '% rows are append-only and cannot be deleted', tg_table_name
         using errcode = 'restrict_violation';
     end if;
     if new.user_id is distinct from old.user_id
        or new.amount_paise is distinct from old.amount_paise
        or new.reference is distinct from old.reference
        or new.type is distinct from old.type
        or new.market_id is distinct from old.market_id
        or new.created_at is distinct from old.created_at then
       raise exception '% rows are append-only: only status may change', tg_table_name
         using errcode = 'restrict_violation';
     end if;
     return new;
   end;
   $$ language plpgsql`,

  `drop trigger if exists ledger_entry_immutable on ledger_entry`,
  `create trigger ledger_entry_immutable before update or delete on ledger_entry
     for each row execute function predik_accounting_row_immutable()`,

  `drop trigger if exists transaction_immutable on "transaction"`,
  `create trigger transaction_immutable before update or delete on "transaction"
     for each row execute function predik_accounting_row_immutable()`,
] as const

/** Every statement this module owns, for the bootstrap and for tests. */
export function securitySchemaStatements(): readonly string[] {
  return [...TABLE_STATEMENTS, ...IMMUTABILITY_STATEMENTS]
}

/** True when this process should create its own schema. */
export function runtimeSchemaBootstrapEnabled(): boolean {
  const configured = (process.env.DATABASE_SCHEMA_BOOTSTRAP ?? 'auto').trim().toLowerCase()
  return configured !== 'off' && configured !== 'false' && configured !== '0'
}

export async function accountingTablesPresent(): Promise<boolean> {
  const result = await db.execute<{ present: boolean }>(sql`
    select (to_regclass('ledger_entry') is not null and to_regclass('"transaction"') is not null) as present
  `)
  return Boolean(result.rows[0]?.present)
}

let tablesEnsured: Promise<void> | null = null
let triggersEnsured = false

/**
 * Creates the rate-limit table and installs the immutability triggers.
 * Idempotent; honors `DATABASE_SCHEMA_BOOTSTRAP=off`.
 *
 * The two halves are tracked separately on purpose. The rate-limit table is a
 * one-shot creation, but the triggers must not be skipped permanently if this
 * process happened to run before the accounting tables existed (a database that
 * is bootstrapped while the app is already serving). Until they are installed
 * the check is re-attempted, so the ledger guarantee always converges to
 * "enforced" rather than silently never applying.
 */
export function ensureSecuritySchema(): Promise<void> {
  if (!runtimeSchemaBootstrapEnabled()) return Promise.resolve()
  tablesEnsured ??= runTableStatements().catch((error) => {
    tablesEnsured = null
    throw error
  })
  return tablesEnsured.then(installImmutabilityTriggers)
}

async function runTableStatements() {
  for (const statement of TABLE_STATEMENTS) {
    await db.execute(sql.raw(statement))
  }
}

async function installImmutabilityTriggers() {
  if (triggersEnsured) return
  // The triggers reference the accounting tables; skip (rather than fail) if the
  // accounting schema does not exist yet — the next call retries.
  if (!(await accountingTablesPresent())) return
  for (const statement of IMMUTABILITY_STATEMENTS) {
    await db.execute(sql.raw(statement))
  }
  triggersEnsured = true
}

/** Test/bootstrap helper: forget the memoized state. */
export function resetSecuritySchemaCache() {
  tablesEnsured = null
  triggersEnsured = false
}
