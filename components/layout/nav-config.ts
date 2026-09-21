import {
  Compass,
  LayoutGrid,
  PieChart,
  Receipt,
  Settings2,
  Trophy,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: typeof Compass
  badge?: string
}

/** Mirrors the Android bottom bar: Explore · Ranking · Referral · Portfolio · Me. */
export const mobileNav: NavItem[] = [
  { href: '/', label: 'Explore', icon: Compass },
  { href: '/ranking', label: 'Ranking', icon: Trophy },
  { href: '/referral', label: 'Referral', icon: Users },
  { href: '/portfolio', label: 'Portfolio', icon: PieChart },
  { href: '/profile', label: 'Me', icon: UserRound },
]

export const desktopNav: NavItem[] = [
  { href: '/', label: 'Explore', icon: Compass },
  { href: '/markets', label: 'All markets', icon: LayoutGrid },
  { href: '/portfolio', label: 'Portfolio', icon: PieChart },
  { href: '/wallet', label: 'Wallet', icon: Wallet },
  { href: '/activity', label: 'Activity', icon: Receipt },
  { href: '/ranking', label: 'Ranking', icon: Trophy },
  { href: '/referral', label: 'Referral', icon: Users },
]

export const secondaryNav: NavItem[] = [
  { href: '/profile', label: 'Account', icon: UserRound },
  { href: '/admin', label: 'Admin', icon: Settings2 },
]
