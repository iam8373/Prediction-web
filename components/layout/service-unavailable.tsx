import { AlertTriangle } from 'lucide-react'
import Link from 'next/link'

import { Card } from '@/components/ui/primitives'
import type { UnavailableReason } from '@/lib/db/availability'

/**
 * What every database-backed page shows when it cannot read its data.
 *
 * The visitor-facing copy is identical for both reasons on purpose: a visitor
 * must never be told how the deployment is configured, so `not-configured` and
 * `unreachable` are not distinguished in production. In development the exact
 * cause is printed, because there the reader is the developer.
 *
 * The operator's detail is one click away at `/api/health`, which reports
 * `database.configured` and `checks.database` and has never returned a value.
 */
export function ServiceUnavailable({ reason }: { reason: UnavailableReason }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md p-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-warning/10">
          <AlertTriangle className="size-6 text-warning" />
        </div>

        <h1 className="mt-4 text-lg font-bold text-foreground">Predik is temporarily unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Market data can&apos;t be loaded right now. Nothing has been lost — your wallet balance,
          positions and payments are unchanged, and no trade was affected.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">Please try again in a moment.</p>

        {process.env.NODE_ENV !== 'production' && (
          <p className="mt-3 rounded-lg bg-muted px-3 py-2 font-mono text-[11px] break-words text-muted-foreground">
            {reason === 'not-configured'
              ? 'development detail: DATABASE_URL is not set, so there is no database to read'
              : 'development detail: the database is configured but did not respond'}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Reload
          </Link>
          <Link
            href="/api/health"
            className="inline-flex items-center justify-center rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
          >
            System status
          </Link>
        </div>
      </Card>
    </div>
  )
}
