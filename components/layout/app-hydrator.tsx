'use client'

import { useEffect } from 'react'

import { useAppStore } from '@/lib/store/use-app-store'

export function AppHydrator() {
  const hydrate = useAppStore((state) => state.hydrate)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  return null
}
