'use client'

import { usePathname, useRouter } from 'next/navigation'

import { sortLabels } from '@/lib/data/market-filters'
import type { SortKey } from '@/types'

export function SortSelect({ value }: { value: SortKey }) {
  const router = useRouter()
  const pathname = usePathname()

  function onChange(next: string) {
    const sp = new URLSearchParams(window.location.search)
    sp.set('sort', next)
    router.push(`${pathname}?${sp.toString()}`)
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-full border border-border bg-card px-3 text-[13px] font-medium text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
      aria-label="Sort markets"
    >
      {Object.entries(sortLabels).map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </select>
  )
}
