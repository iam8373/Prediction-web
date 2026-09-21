'use client'

import { Bell, Plus, Search } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Logo } from '@/components/layout/logo'
import { DepositModal } from '@/components/wallet/deposit-modal'
import { formatINR } from '@/lib/money'
import { useAppStore } from '@/lib/store/use-app-store'
import { cn } from '@/lib/utils'

export function TopBar() {
  const router = useRouter()
  const pathname = usePathname()
  const user = useAppStore((s) => s.user)
  const wallet = useAppStore((s) => s.wallet)
  const unreadNotifications = useAppStore((s) => s.unreadNotifications)
  const [depositOpen, setDepositOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setQuery(new URLSearchParams(window.location.search).get('q') ?? '')
  }, [pathname])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) return
    const timer = window.setTimeout(() => {
      router.replace(`/markets?q=${encodeURIComponent(trimmed)}`)
    }, 450)
    return () => window.clearTimeout(timer)
  }, [query, router])

  function submitSearch(event: React.FormEvent) {
    event.preventDefault()
    router.push(`/markets?q=${encodeURIComponent(query.trim())}`)
  }

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 lg:h-16 lg:px-6">
          <Link href="/" className="lg:hidden" aria-label="Predik home">
            <Logo />
          </Link>

          <form
            onSubmit={submitSearch}
            role="search"
            className="hidden min-w-0 flex-1 items-center lg:flex"
          >
            <label htmlFor="global-search" className="sr-only">
              Search markets
            </label>
            <div className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="global-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search markets, teams, coins"
                className="h-10 w-full rounded-full border border-border bg-muted/50 pr-4 pl-9 text-sm transition-colors focus-visible:border-ring focus-visible:bg-card focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
              />
            </div>
          </form>

          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <div className="flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pr-1 pl-3">
                <span className="text-sm font-semibold tabular-nums">
                  {formatINR(wallet.availablePaise)}
                </span>
                <button
                  type="button"
                  onClick={() => setDepositOpen(true)}
                  aria-label="Add funds"
                  className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  <Plus className="size-4" />
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                Sign in
              </Link>
            )}

            <Link
              href="/activity"
              aria-label="Notifications and activity"
              className={cn(
                'relative grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                pathname === '/activity' && 'bg-muted text-foreground',
              )}
            >
              <Bell className="size-[18px]" />
              {unreadNotifications > 0 ? (
                <span className="absolute top-2 right-2 size-1.5 rounded-full bg-live" aria-label={`${unreadNotifications} unread notifications`} />
              ) : null}
            </Link>

            <Link
              href="/profile"
              aria-label="Your account"
              className="grid size-9 place-items-center rounded-full bg-accent text-sm font-bold text-accent-foreground"
            >
              {user ? user.name.slice(-2) : 'PD'}
            </Link>
          </div>
        </div>
      </header>

      <DepositModal open={depositOpen} onClose={() => setDepositOpen(false)} />
    </>
  )
}
