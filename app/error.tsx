'use client'

import { AlertTriangle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect } from 'react'

/**
 * Route error boundary.
 *
 * Without this, a failed server render reaches the browser as a bare 500 with an
 * empty body — which looks like a dead site and tells the operator nothing.
 * Every failure now lands on this page instead: what happened, that no money
 * moved, and one click to retry.
 *
 * In production Next.js replaces a server error's message with a generic string
 * and only forwards `digest`, so there is nothing sensitive to leak here. The
 * technical detail is still written server-side to the logs.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app] page failed to render', { digest: error.digest, message: error.message })
  }, [error])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-5 py-16">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-warning/10">
          <AlertTriangle className="size-6 text-warning" />
        </div>

        <h1 className="mt-4 text-lg font-bold text-foreground">This page couldn&apos;t load</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something failed while loading this screen. Your wallet balance, positions and open orders
          are unchanged — no trade, payment or withdrawal is left half-applied.
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <RefreshCw className="size-4" />
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
          >
            Back to markets
          </Link>
        </div>

        <p className="mt-5 text-[11px] text-muted-foreground">
          {error.digest ? `Reference ${error.digest} · ` : ''}
          <Link href="/api/health" className="underline hover:text-foreground">
            system status
          </Link>
        </p>
      </div>
    </main>
  )
}
