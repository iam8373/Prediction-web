import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * Liveness probe — is this process serving requests at all?
 *
 * Deliberately says nothing about the database, so a platform health check can
 * keep a running deployment alive while a dependency is still being provisioned.
 * Readiness — does the app actually work? — is `/api/health`, which answers 503
 * until PostgreSQL is reachable and the schema exists.
 *
 * Exposes nothing: a constant body, no version, no configuration.
 *
 *  200 — the process is up and routing
 */
export async function GET() {
  return NextResponse.json(
    { ok: true, service: 'predik', probe: 'liveness' },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  )
}
