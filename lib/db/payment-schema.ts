import 'server-only'

import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'

/**
 * Phase 9 payment tables.
 *
 * This project has no migration runner (the catalogue tables are created and
 * seeded on demand), so the payment tables follow the same pattern: idempotent
 * `create table if not exists` DDL that runs once per server process, before
 * the first payment read or write.
 *
 * The statements mirror `lib/db/schema.ts` exactly. Indexes are created
 * separately so the unique constraints that make retries and duplicate
 * webhooks harmless exist even on databases that already had partial tables:
 *
 *  - payment_intent (user_id, request_key)          -> one payment per request
 *  - payment_intent (provider, provider_payment_id) -> one record per provider payment
 *  - payment_webhook_event (provider, provider_event_id) -> one effect per event
 *  - payment_reconciliation_finding (run_id, payment_intent_id) -> one finding per payment per run
 *
 * These are the database-level guarantees behind the service's idempotency, not
 * client-side prevention.
 */

const STATEMENTS = [
  `create table if not exists payment_account (
    user_id text primary key,
    status text not null default 'active',
    kyc_status text not null default 'unverified',
    jurisdiction text,
    live_eligible boolean not null default false,
    restricted_reason text,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now()
  )`,
  `create index if not exists payment_account_status_idx on payment_account (status)`,

  `create table if not exists payment_intent (
    id text primary key,
    user_id text not null,
    direction text not null,
    status text not null,
    mode text not null,
    provider text not null,
    provider_status text,
    currency text not null,
    amount_paise bigint not null,
    provider_amount_paise bigint,
    fee_paise bigint not null default 0,
    net_paise bigint not null default 0,
    method text,
    destination text,
    provider_payment_id text,
    provider_reference text,
    provider_order_ref text,
    provider_destination_ref text,
    provider_idempotency_key text,
    checkout_url text,
    recheck_attempts integer not null default 0,
    last_rechecked_at bigint,
    request_key text not null,
    transaction_id text,
    parent_payment_id text,
    refund_status text not null default 'none',
    reconciliation_status text not null default 'unchecked',
    failure_code text,
    failure_reason text,
    created_at bigint not null,
    updated_at bigint not null,
    settled_at bigint
  )`,
  `create unique index if not exists payment_intent_request_idx on payment_intent (user_id, request_key)`,
  `create unique index if not exists payment_intent_provider_payment_idx on payment_intent (provider, provider_payment_id)`,
  `create index if not exists payment_intent_user_created_idx on payment_intent (user_id, created_at)`,
  `create index if not exists payment_intent_status_idx on payment_intent (status)`,
  `create index if not exists payment_intent_reconciliation_idx on payment_intent (reconciliation_status)`,
  `create index if not exists payment_intent_parent_idx on payment_intent (parent_payment_id)`,
  `create index if not exists payment_intent_provider_order_idx on payment_intent (provider_order_ref)`,

  // Step 2 additions. `create table if not exists` above already includes these
  // columns for fresh databases; these ALTERs upgrade a Step 1 database.
  `alter table if exists payment_intent add column if not exists provider_order_ref text`,
  `alter table if exists payment_intent add column if not exists provider_destination_ref text`,
  `alter table if exists payment_intent add column if not exists provider_idempotency_key text`,
  `alter table if exists payment_intent add column if not exists checkout_url text`,
  `alter table if exists payment_intent add column if not exists recheck_attempts integer not null default 0`,
  `alter table if exists payment_intent add column if not exists last_rechecked_at bigint`,

  `create table if not exists payment_webhook_event (
    id text primary key,
    provider text not null,
    provider_event_id text not null,
    event_type text not null,
    status text not null,
    payment_intent_id text,
    provider_payment_id text,
    payload_fingerprint text not null,
    error text,
    attempts integer not null default 1,
    received_at bigint not null,
    processed_at bigint
  )`,
  `create unique index if not exists payment_webhook_event_unique_idx on payment_webhook_event (provider, provider_event_id)`,
  `create index if not exists payment_webhook_event_status_idx on payment_webhook_event (status, received_at)`,
  `create index if not exists payment_webhook_event_payment_idx on payment_webhook_event (payment_intent_id)`,

  `create table if not exists payment_reconciliation_run (
    id text primary key,
    provider text not null,
    mode text not null,
    status text not null,
    checked_count integer not null default 0,
    matched_count integer not null default 0,
    mismatch_count integer not null default 0,
    notes text,
    started_at bigint not null,
    finished_at bigint,
    triggered_by_user_id text
  )`,
  `create index if not exists payment_reconciliation_run_started_idx on payment_reconciliation_run (started_at)`,
  `create index if not exists payment_reconciliation_run_provider_idx on payment_reconciliation_run (provider, started_at)`,

  `create table if not exists payment_reconciliation_finding (
    id text primary key,
    run_id text not null,
    provider text not null,
    payment_intent_id text not null,
    status text not null,
    internal_status text,
    provider_status text,
    internal_amount_paise bigint,
    provider_amount_paise bigint,
    notes text,
    resolved_at bigint,
    resolved_by_user_id text,
    created_at bigint not null
  )`,
  `create unique index if not exists payment_reconciliation_finding_run_idx on payment_reconciliation_finding (run_id, payment_intent_id)`,
  `create index if not exists payment_reconciliation_finding_payment_idx on payment_reconciliation_finding (payment_intent_id, created_at)`,
  `create index if not exists payment_reconciliation_finding_status_idx on payment_reconciliation_finding (status, created_at)`,

  `create table if not exists audit_log (
    id text primary key,
    actor_role text not null,
    actor_user_id text,
    action text not null,
    entity_type text not null,
    entity_id text not null,
    summary text not null,
    metadata jsonb,
    created_at bigint not null
  )`,
  `create index if not exists audit_log_entity_idx on audit_log (entity_type, entity_id)`,
  `create index if not exists audit_log_action_idx on audit_log (action, created_at)`,
  `create index if not exists audit_log_actor_idx on audit_log (actor_user_id, created_at)`,
] as const

/**
 * The payment DDL as data. Exposed so the bootstrap can be replayed
 * deliberately (a fresh database, or a test suite that resets the schema)
 * without depending on the per-process memoization of `ensurePaymentSchema`.
 */
export function paymentSchemaStatements(): readonly string[] {
  return STATEMENTS
}

let ensured: Promise<void> | null = null

export function ensurePaymentSchema(): Promise<void> {
  // Memoized per process: the DDL is idempotent, but there is no reason to
  // repeat it before every payment read or write.

  ensured ??= createPaymentTables().catch((error) => {
    ensured = null
    throw error
  })
  return ensured
}

async function createPaymentTables() {
  for (const statement of paymentSchemaStatements()) {
    await db.execute(sql.raw(statement))
  }
}
