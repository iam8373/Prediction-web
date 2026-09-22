import type { Category } from '@/types'

export const categories: Category[] = [
  { id: 'cricket', name: 'Cricket', slug: 'cricket', icon: 'Trophy', accent: 'oklch(0.72 0.15 167)' },
  { id: 'football', name: 'Football', slug: 'football', icon: 'CircleDot', accent: 'oklch(0.62 0.17 250)' },
  { id: 'entertainment', name: 'Entertainment', slug: 'entertainment', icon: 'Clapperboard', accent: 'oklch(0.65 0.2 340)' },
  { id: 'esports', name: 'Esports', slug: 'esports', icon: 'Gamepad2', accent: 'oklch(0.6 0.2 300)' },
  { id: 'politics', name: 'Politics', slug: 'politics', icon: 'Landmark', accent: 'oklch(0.6 0.15 30)' },
  { id: 'tech', name: 'Tech', slug: 'tech', icon: 'Cpu', accent: 'oklch(0.62 0.14 220)' },
  { id: 'finance', name: 'Finance', slug: 'finance', icon: 'TrendingUp', accent: 'oklch(0.62 0.14 145)' },
  { id: 'world', name: 'World', slug: 'world', icon: 'Globe2', accent: 'oklch(0.6 0.12 200)' },
]

export const categoryMap = new Map(categories.map((c) => [c.id, c]))

export function getCategory(id: string): Category | undefined {
  return categoryMap.get(id)
}
