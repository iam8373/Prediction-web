'use client'

import { Bookmark, BookmarkCheck } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { useAppStore } from '@/lib/store/use-app-store'
import { cn } from '@/lib/utils'

export function WatchlistButton({ marketId }: { marketId: string }) {
  const user = useAppStore((state) => state.user)
  const watching = useAppStore((state) => state.watchlist.includes(marketId))
  const toggleWatch = useAppStore((state) => state.toggleWatch)

  if (!user) {
    return (
      <Link
        href="/login"
        aria-label="Sign in to save this market"
        className={cn(
          'inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-sm transition-colors hover:bg-muted hover:text-foreground',
          'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        )}
      >
        <Bookmark className="size-4" />
      </Link>
    )
  }

  return (
    <Button
      type="button"
      variant={watching ? 'secondary' : 'outline'}
      size="icon"
      aria-label={watching ? 'Remove market from watchlist' : 'Save market to watchlist'}
      aria-pressed={watching}
      onClick={() => void toggleWatch(marketId)}
    >
      {watching ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
    </Button>
  )
}
