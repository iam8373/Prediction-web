'use client'

import { Bell, CheckCircle2, CircleDollarSign, Gift, Radio } from 'lucide-react'
import Link from 'next/link'

import { Card, EmptyState } from '@/components/ui/primitives'
import { formatDateTime } from '@/lib/date'
import { cn } from '@/lib/utils'
import type { Notification } from '@/types'

const ICONS = {
  trade: CircleDollarSign,
  settlement: CheckCircle2,
  market: Radio,
  account: Bell,
  referral: Gift,
} as const

export function NotificationList({
  notifications,
  onRead,
}: {
  notifications: Notification[]
  onRead: (id: string) => void
}) {
  if (notifications.length === 0) {
    return <EmptyState icon={<Bell className="size-7" />} title="No notifications" description="Trade confirmations and account updates will appear here." />
  }

  return (
    <Card className="divide-y divide-border">
      {notifications.map((notification) => {
        const Icon = ICONS[notification.kind] ?? Bell
        const content = (
          <>
            <span className={cn('grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground', !notification.readAt && 'bg-accent text-accent-foreground')}>
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-foreground">{notification.title}</span>
                {!notification.readAt ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" /> : null}
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{notification.description}</span>
              <span className="mt-1 block text-[11px] text-muted-foreground">{formatDateTime(notification.createdAt)}</span>
            </span>
          </>
        )

        return notification.href ? (
          <Link
            key={notification.id}
            href={notification.href}
            onClick={() => {
              if (!notification.readAt) onRead(notification.id)
            }}
            className={cn('flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50', !notification.readAt && 'bg-accent/20')}
          >
            {content}
          </Link>
        ) : (
          <button
            key={notification.id}
            type="button"
            onClick={() => {
              if (!notification.readAt) onRead(notification.id)
            }}
            className={cn('flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50', !notification.readAt && 'bg-accent/20')}
          >
            {content}
          </button>
        )
      })}
    </Card>
  )
}
