import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { getPaymentConfig } from '@/lib/payments/config'

export const dynamic = 'force-dynamic'

/**
 * Production health probe.
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
 * Configuration *detail* (which environment variables are missing, why the live
 * gate is closed) is intentionally NOT returned here; operators read that from
 * the authenticated admin payment screens or `pnpm preflight`.
 */
export async function GET() {
  const startedAt = Date.now()
  let databaseReachable = false
  let schemaReady = false

  try {
    await db.execute(sql`select 1`)
    databaseReachable = true
    // A cheap existence probe: the wallet table is core to every money path.
    const result = await db.execute(sql`select to_regclass('public.wallet') as wallet`)
    const rows = result.rows as Array<{ wallet: string | null }>
    schemaReady = Boolean(rows[0]?.wallet)
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
        database: !databaseReachable ? 'unavailable' : schemaReady ? 'ok' : 'schema-incomplete',
      },
      database: {
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
