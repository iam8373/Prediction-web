import { Clock3, Flame, Radio, Sparkles, TrendingUp } from 'lucide-react'
import Link from 'next/link'

import { AppShell } from '@/components/layout/app-shell'
import { ServiceUnavailable } from '@/components/layout/service-unavailable'
import { CategoryTabs } from '@/components/markets/category-tabs'
import { MarketGrid } from '@/components/markets/market-grid'
import { SectionHeading } from '@/components/ui/primitives'
import { loadOrUnavailable } from '@/lib/db/availability'
import {
  closingSoonMarkets,
  featuredMarkets,
  getCategories,
  highestVolumeMarkets,
  liveMarkets,
  newestMarkets,
  platformStats,
} from '@/lib/data/server-api'
import { formatCompactINR, formatCount } from '@/lib/money'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  // A database that cannot be read must produce a page, not an empty 500.
  const loaded = await loadOrUnavailable('home catalog', () => Promise.all([
    platformStats(),
    featuredMarkets(4),
    liveMarkets(6),
    closingSoonMarkets(6),
    newestMarkets(6),
    highestVolumeMarkets(6),
    getCategories(),
  ]))

  if (!loaded.ok) {
    return (
      <AppShell>
        <ServiceUnavailable reason={loaded.reason} />
      </AppShell>
    )
  }

  const [stats, featured, live, closingSoon, newest, topVolume, categoryRows] = loaded.value

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="rounded-2xl bg-gradient-to-br from-primary/15 via-accent/40 to-transparent p-5">
          <p className="text-xs font-semibold tracking-wide text-primary uppercase">Predik</p>
          <h1 className="mt-1 text-xl font-bold text-foreground lg:text-2xl">
            Trade your predictions on cricket, football, politics and more
          </h1>
          <div className="mt-4 flex flex-wrap gap-5 text-sm">
            <Stat label="Platform volume" value={formatCompactINR(stats.volumePaise)} />
            <Stat label="Open markets" value={`${stats.openMarkets}`} />
            <Stat label="Traders" value={formatCount(stats.traders)} />
          </div>
        </section>

        <CategoryTabs items={categoryRows} />

        <Section title="Featured" icon={<Sparkles className="size-4 text-primary" />} href="/markets">
          <MarketGrid markets={featured} />
        </Section>

        <Section title="Live now" icon={<Radio className="size-4 text-live" />} href="/markets?sort=trending">
          <MarketGrid markets={live} />
        </Section>

        <Section title="Closing soon" icon={<Clock3 className="size-4 text-warning" />} href="/markets?sort=closing">
          <MarketGrid markets={closingSoon} />
        </Section>

        <Section title="Highest volume" icon={<TrendingUp className="size-4 text-primary" />} href="/markets?sort=volume">
          <MarketGrid markets={topVolume} />
        </Section>

        <Section title="Recently created" icon={<Flame className="size-4 text-no" />} href="/markets?sort=newest">
          <MarketGrid markets={newest} />
        </Section>
      </div>
    </AppShell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-base font-bold text-foreground">{value}</p>
    </div>
  )
}

function Section({
  title,
  icon,
  href,
  children,
}: {
  title: string
  icon: React.ReactNode
  href: string
  children: React.ReactNode
}) {
  return (
    <section>
      <SectionHeading
        title={title}
        icon={icon}
        action={
          <Link href={href} className="text-xs font-semibold text-primary hover:underline">
            See all
          </Link>
        }
      />
      {children}
    </section>
  )
}
