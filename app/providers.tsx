'use client'

import { AppHydrator } from '@/components/layout/app-hydrator'
import { ToastProvider } from '@/components/ui/toast'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AppHydrator />
      {children}
    </ToastProvider>
  )
}
