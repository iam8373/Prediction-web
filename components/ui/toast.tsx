'use client'

import { AlertCircle, CheckCircle2, Info } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'

type ToastTone = 'success' | 'error' | 'info'

interface Toast {
  id: number
  title: string
  description?: string
  tone: ToastTone
}

interface ToastContextValue {
  toast: (input: { title: string; description?: string; tone?: ToastTone }) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

let toastId = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const toast = useCallback(
    ({
      title,
      description,
      tone = 'info',
    }: {
      title: string
      description?: string
      tone?: ToastTone
    }) => {
      toastId += 1
      const id = toastId
      setToasts((current) => [...current, { id, title, description, tone }])
      setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== id))
      }, 4200)
    },
    [],
  )

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-3 bottom-24 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            role="status"
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border bg-card px-4 py-3 shadow-lg animate-in slide-in-from-bottom-2',
              item.tone === 'success' && 'border-yes/30',
              item.tone === 'error' && 'border-no/30',
              item.tone === 'info' && 'border-border',
            )}
          >
            {item.tone === 'success' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-yes" />
            ) : item.tone === 'error' ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-no" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{item.title}</p>
              {item.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
