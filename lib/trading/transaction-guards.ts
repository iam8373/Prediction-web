import 'server-only'

import { randomUUID } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'

const MAX_REQUEST_KEY_LENGTH = 128

type TransactionExecutor = {
  execute: (query: SQL) => unknown
}

export function getRequestKey(request: Request) {
  const value = request.headers.get('Idempotency-Key')?.trim()
  if (value && value.length > MAX_REQUEST_KEY_LENGTH) {
    throw new Error('INVALID_IDEMPOTENCY_KEY')
  }
  return value || randomUUID()
}

/** Serialize retries and same-resource financial operations inside PostgreSQL. */
export async function lockResource(
  tx: TransactionExecutor,
  scope: string,
  ...parts: string[]
) {
  const key = [scope, ...parts].join(':')
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}

/**
 * PostgreSQL unique-violation (SQLSTATE 23505) detection.
 *
 * The driver error is not always the object the caller catches: Drizzle wraps
 * driver failures in its own `DrizzleQueryError` ("Failed query: ...") and keeps
 * the PostgreSQL error on `cause`. Checking only the top level made a duplicate
 * webhook delivery look like an unexpected failure — the insert threw, the
 * duplicate path never ran, and the provider was told the delivery failed. This
 * walks the cause chain so the unique constraint is treated as the idempotency
 * signal it is.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown; constraint?: unknown }
    if (candidate.code === '23505') return true
    current = candidate.cause
  }
  return false
}
