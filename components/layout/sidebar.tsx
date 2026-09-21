'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { Logo } from '@/components/layout/logo'
import { desktopNav, secondaryNav } from '@/components/layout/nav-config'
import { categories } from '@/lib/data/categories'
import { cn } from '@/lib/utils'

export function Sidebar() {
  const pathname = usePathname()

  function linkClass(href: string) {
    const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
    return cn(
      'flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
      active
        ? 'bg-accent text-accent-foreground'
        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
    )
  }

  return (
    <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-card px-4 py-5 lg:flex">
      <Link href="/" className="px-1" aria-label="Predik home">
        <Logo />
      </Link>

      <nav aria-label="Main">
        <ul className="space-y-1">
          {desktopNav.map((item) => {
            const Icon = item.icon
            return (
              <li key={item.href}>
                <Link href={item.href} className={linkClass(item.href)}>
                  <Icon className="size-[18px]" />
                  {item.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div>
        <p className="px-3 pb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Categories
        </p>
        <ul className="space-y-0.5">
          {categories.map((category) => (
            <li key={category.id}>
              <Link
                href={`/markets?category=${category.slug}`}
                className="flex items-center gap-2.5 rounded-xl px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ background: category.accent }}
                />
                {category.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <nav aria-label="Account" className="mt-auto">
        <ul className="space-y-1">
          {secondaryNav.map((item) => {
            const Icon = item.icon
            return (
              <li key={item.href}>
                <Link href={item.href} className={linkClass(item.href)}>
                  <Icon className="size-[18px]" />
                  {item.label}
                </Link>
              </li>
            )
          })}
        </ul>
        <p className="mt-4 px-3 text-[11px] leading-4 text-muted-foreground">
          Demo build. Balances are play money and no real payments are processed.
        </p>
      </nav>
    </aside>
  )
}
