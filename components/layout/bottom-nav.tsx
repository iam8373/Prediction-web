'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { mobileNav } from '@/components/layout/nav-config'
import { cn } from '@/lib/utils'

export function BottomNav() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {mobileNav.map((item) => {
          const active =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex flex-col items-center gap-1 py-2 text-[11px] font-medium transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <span className="relative">
                  <Icon className={cn('size-[22px]', active && 'stroke-[2.4]')} />
                  {item.badge ? (
                    <span className="absolute -top-1.5 -right-3 rounded-full bg-live px-1 text-[9px] leading-[14px] font-bold text-white">
                      {item.badge}
                    </span>
                  ) : null}
                </span>
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
