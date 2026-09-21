import Link from 'next/link'

import { categories as fallbackCategories } from '@/lib/data/categories'
import { cn } from '@/lib/utils'
import type { Category } from '@/types'

export function CategoryTabs({ active, items = fallbackCategories }: { active?: string; items?: Category[] }) {
  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
      <Link
        href="/markets"
        className={cn(
          'shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors',
          !active
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-card text-muted-foreground hover:text-foreground',
        )}
      >
        All
      </Link>
      {items.map((c) => (
        <Link
          key={c.id}
          href={`/markets?category=${c.slug}`}
          className={cn(
            'shrink-0 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors',
            active === c.slug
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-card text-muted-foreground hover:text-foreground',
          )}
        >
          {c.name}
        </Link>
      ))}
    </div>
  )
}
