import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db } from '@/lib/db'
import { markets } from '@/lib/db/schema'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { lockResource } from '@/lib/trading/transaction-guards'

const schema = z.object({
  marketId: z.string().trim().min(1).max(120),
  status: z.enum(['open', 'paused', 'closed']),
})

export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminMarket', scope: 'admin.markets.status' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const { marketId, status } = schema.parse(await readJsonBody(request))
    const result = await db.transaction(async (tx) => {
      await lockResource(tx, 'market', marketId)
      const [market] = await tx.select({ id: markets.id, status: markets.status }).from(markets).where(eq(markets.id, marketId)).for('update').limit(1)
      if (!market) throw new Error('UNKNOWN_MARKET')
      if (market.status === 'resolved') throw new Error('MARKET_RESOLVED')
      const [updated] = await tx
        .update(markets)
        .set({ status })
        .where(and(eq(markets.id, marketId), eq(markets.status, market.status)))
        .returning({ id: markets.id })
      if (!updated) throw new Error('MARKET_CONFLICT')
      return { ok: true, previousStatus: market.status }
    })

    await recordAudit({
      actorRole: 'admin',
      actorUserId: admin.id,
      action: AUDIT_ACTIONS.marketStatusChanged,
      entityType: 'market',
      entityId: marketId,
      summary: `Market status ${result.previousStatus} -> ${status}`,
      metadata: { from: result.previousStatus, to: status },
    })

    return NextResponse.json(result)
  } catch (error) {
    const security = securityErrorResponse(error)
    if (security) return security
    const message = error instanceof Error ? error.message : ''
    if (error instanceof z.ZodError) return NextResponse.json({ ok: false, error: error.issues[0]?.message ?? 'Invalid market status' }, { status: 400 })
    if (message === 'UNKNOWN_MARKET') return NextResponse.json({ ok: false, error: 'Unknown market' }, { status: 404 })
    if (message === 'MARKET_RESOLVED' || message === 'MARKET_CONFLICT') return NextResponse.json({ ok: false, error: 'Market has already changed. Refresh and try again.' }, { status: 409 })
    console.error('[v0] market status update failed', error)
    return NextResponse.json({ ok: false, error: 'The market status could not be updated' }, { status: 500 })
  }
}
