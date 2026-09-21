import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { isDatabaseConfigured } from '@/lib/db/config'
import { getPaymentConfig } from '@/lib/payments/config'

/**
 * Production readiness probe.
 *
 * Deliberately minimal and safe to leave unauthenticated: it answers whether the
 * process is serving requests and whether PostgreSQL is reachable, and it
 * reports the payment posture as booleans so a monitor can alert on
 * `payments.mutationBlocked` without ever exposing a secret, a stack trace or a
 * connection string.
 *
 *  200 — the application is up and the database answered
 *  503 — the application is up but a critical dependency is not ready
 *
 * Liveness for a platform health check is `/api/health/live`, which ignores the
 * database on purpose so a dependency still being provisioned cannot fail a
 * deploy.
 *
 * Configuration *detail* (which environment variables are missing, why the live
 * gate is closed) is intentionally NOT returned here; operators read that from
 * the deploy logs, the authenticated admin screens or `pnpm preflight`.
 */
export const dynamic = 'force-dynamic'

/** A monitor must get an answer even if the database never responds. */
const PROBE_TIMEOUT_MS = 4_000

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function GET() {
  const startedAt = Date.now()
  let databaseReachable = false
  let schemaReady = false
  let timedOut = false

  try {
    const probe = await withTimeout(
      (async () => {
        await db.execute(sql`select 1`)
        // A cheap existence probe: the wallet table is core to every money path.
        const result = await db.execute(sql`select to_regclass('public.wallet') as wallet`)
        const rows = result.rows as Array<{ wallet: string | null }>
        return Boolean(rows[0]?.wallet)
      })(),
      PROBE_TIMEOUT_MS,
    )

    if (probe === 'timeout') {
      timedOut = true
    } else {
      databaseReachable = true
      schemaReady = probe
    }
  } catch {
    // Never surfaced: a driver error can contain the connection host and role.
    console.error('[health] database probe failed')
  }

  const payments = getPaymentConfig()
  const ok = databaseReachable && schemaReady

  return NextResponse.json(
    {
      ok,
      service: 'predik',
      timestamp: new Date().toISOString(),
      checks: {
        application: 'ok',
        database: timedOut
          ? 'timeout'
          : !databaseReachable
            ? 'unavailable'
            : schemaReady
              ? 'ok'
              : 'schema-incomplete',
      },
      database: {
        // `configured: false` is the single most useful signal for an operator:
        // it means DATABASE_URL was never set, which is a different problem from
        // a database that is down. The value itself is never returned.
        configured: isDatabaseConfigured(),
        reachable: databaseReachable,
        schemaReady,
        latencyMs: Date.now() - startedAt,
      },
      payments: {
        mode: payments.effective,
        requestedMode: payments.requested,
        liveEnabled: payments.liveEnabled,
        // True means this deployment refuses new monetary exposure: alert on it,
        // it is never a normal steady state for a live deployment.
        mutationBlocked: payments.mutationBlocked,
        sandboxReady: payments.sandboxReady,
        currency: payments.currency,
      },
    },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  )
}
