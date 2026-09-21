import type { Metadata } from 'next'

import { AppShell } from '@/components/layout/app-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { CategoryTabs } from '@/components/markets/category-tabs'
import { MarketGrid } from '@/components/markets/market-grid'
import { SortSelect } from '@/components/markets/sort-select'
import { getCategories, queryMarkets } from '@/lib/data/server-api'
import { loadOrUnavailable } from '@/lib/db/availability'
import type { SortKey } from '@/types'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'All markets · Predik',
  description: 'Browse every prediction market on Predik and trade Yes/No outcomes in real time.',
}

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const category = typeof sp.category === 'string' ? sp.category : undefined
  const query = typeof sp.q === 'string' ? sp.q : ''
  const sort = (typeof sp.sort === 'string' ? sp.sort : 'trending') as SortKey
  const status = sp.status === 'resolved' ? 'resolved' : 'live'

  // A database that cannot be read must produce a page, not an empty 500.
  const loaded = await loadOrUnavailable('market list', () => Promise.all([
    queryMarkets({ category, query, sort, status, perPage: 24 }),
    getCategories(),
  ]))

  if (!loaded.ok) {
    return (
      <AppShell>
        <ServiceUnavailable reason={loaded.reason} />
      </AppShell>
    )
  }

  const [result, categoryRows] = loaded.value
  const categoryRow = category ? categoryRows.find((row) => row.id === category || row.slug === category) : undefined
  const categoryLabel = categoryRow?.name
  const invalidCategory = Boolean(category && !categoryRow)

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-bold text-foreground">
            {invalidCategory ? 'Category not found' : categoryLabel ?? (query ? `Results for "${query}"` : 'All markets')}
          </h1>
          <SortSelect value={sort} />
        </div>
        <CategoryTabs active={category} items={categoryRows} />
        <p className="text-xs text-muted-foreground">{invalidCategory ? 'Choose a category below to continue.' : `${result.total} markets`}</p>
        <MarketGrid
          markets={result.items}
          emptyMessage={query ? `No markets found for "${query}"` : 'No markets in this category yet.'}
        />
      </div>
    </AppShell>
  )
}
