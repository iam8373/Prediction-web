import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { markets, watchlists } from '@/lib/db/schema'
import { guardRequest, readJsonBody, routeFailureResponse } from '@/lib/security/guard'

const watchlistSchema = z.object({
  marketId: z.string().trim().min(1).max(120),
  watched: z.boolean(),
})

async function listWatchlist(userId: string) {
  const rows = await db
    .select({ marketId: watchlists.marketId })
    .from(watchlists)
    .where(eq(watchlists.userId, userId))
    .orderBy(watchlists.createdAt)
  return rows.map((row) => row.marketId)
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to view your watchlist' }, { status: 401 })
  return NextResponse.json({ ok: true, watchlist: await listWatchlist(user.id) })
}

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to update your watchlist' }, { status: 401 })

  try {
    await guardRequest({ request, scope: 'watchlist.update' })
    const input = watchlistSchema.parse(await readJsonBody(request))
    const [market] = await db
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, input.marketId))
      .limit(1)
    if (!market) return NextResponse.json({ ok: false, error: 'Market not found' }, { status: 404 })

    if (input.watched) {
      await db.insert(watchlists).values({
        userId: user.id,
        marketId: input.marketId,
        createdAt: Date.now(),
      }).onConflictDoNothing()
    } else {
      await db.delete(watchlists).where(and(eq(watchlists.userId, user.id), eq(watchlists.marketId, input.marketId)))
    }

    return NextResponse.json({
      ok: true,
      watched: input.watched,
      watchlist: await listWatchlist(user.id),
    })
  } catch (error) {
    return routeFailureResponse(error, {
      area: '[watchlist]',
      operation: 'update failed',
      message: 'Could not update your watchlist',
      invalidMessage: 'Invalid watchlist request',
    })
  }
}
