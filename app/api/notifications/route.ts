import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { notifications } from '@/lib/db/schema'
import { getNotifications } from '@/lib/data/server-api'
import { guardRequest, readJsonBody, routeFailureResponse } from '@/lib/security/guard'

const readSchema = z.object({
  id: z.string().min(1).optional(),
  all: z.boolean().optional(),
}).refine((value) => Boolean(value.id) !== Boolean(value.all), 'Choose one notification or all notifications')

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to view notifications' }, { status: 401 })

  const [items, unreadRows] = await Promise.all([
    getNotifications(user.id),
    db.select({ unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)` })
      .from(notifications)
      .where(eq(notifications.userId, user.id)),
  ])
  return NextResponse.json({ ok: true, notifications: items, unread: Number(unreadRows[0]?.unread ?? 0) })
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to update notifications' }, { status: 401 })

  try {
    await guardRequest({ request, scope: 'notifications.read' })
    const input = readSchema.parse(await readJsonBody(request))
    const now = Date.now()
    if (input.all) {
      await db.update(notifications)
        .set({ readAt: now })
        .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))
    } else if (input.id) {
      await db.update(notifications)
        .set({ readAt: now })
        .where(and(eq(notifications.userId, user.id), eq(notifications.id, input.id)))
    }

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(50)
    const unreadRows = await db
      .select({ unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)` })
      .from(notifications)
      .where(eq(notifications.userId, user.id))
    return NextResponse.json({
      ok: true,
      notifications: rows.map((row) => ({
        id: row.id,
        eventKey: row.eventKey,
        kind: row.kind,
        title: row.title,
        description: row.description,
        href: row.href ?? undefined,
        readAt: row.readAt ?? undefined,
        createdAt: row.createdAt,
      })),
      unread: Number(unreadRows[0]?.unread ?? 0),
    })
  } catch (error) {
    return routeFailureResponse(error, {
      area: '[notifications]',
      operation: 'update failed',
      message: 'Could not update notifications',
      invalidMessage: 'Invalid notification request',
    })
  }
}
