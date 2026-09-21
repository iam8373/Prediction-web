import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'

import { AUDIT_ACTIONS, recordAudit } from '@/lib/audit/log'
import { db } from '@/lib/db'
import { marketOutcomes, marketPriceHistory, markets } from '@/lib/db/schema'
import { requireAdmin } from '@/lib/security/admin-guard'
import { readJsonBody, routeFailureResponse } from '@/lib/security/guard'
import { marketFormSchema } from '@/lib/validation/schemas'

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72)
}

export async function POST(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'adminMarket', scope: 'admin.markets.create' })
  if (!guard.ok) return guard.response
  const admin = guard.admin

  try {
    const input = marketFormSchema.parse(await readJsonBody(request))
    const now = Date.now()
    const id = `market_${randomUUID()}`
    const yesPricePaise = Math.round((input.initialYesProbability / 100) * 1000)
    const baseSlug = slugify(input.question) || id
    const slug = `${baseSlug}-${id.slice(-8)}`

    await db.transaction(async (tx) => {
      await tx.insert(markets).values({
        id,
        slug,
        question: input.question,
        headline: `${input.yesLabel} vs ${input.noLabel}`,
        description: input.description,
        resolutionCriteria: input.resolutionCriteria,
        source: input.source,
        categoryId: input.categoryId,
        kind: 'binary',
        status: input.status,
        emblem: input.yesLabel.slice(0, 3).toUpperCase(),
        live: false,
        featured: false,
        bonus: false,
        createdAt: now,
        opensAt: new Date(input.opensAt).getTime(),
        closesAt: new Date(input.closesAt).getTime(),
        resolvesAt: new Date(input.resolvesAt).getTime(),
        volumePaise: 0,
        liquidityPaise: input.initialLiquidityRupees * 100,
        traders: 0,
      })
      await tx.insert(marketOutcomes).values([
        { id: `${id}:yes`, marketId: id, name: input.yesLabel, side: 'yes', pricePaise: yesPricePaise, previousPricePaise: yesPricePaise },
        { id: `${id}:no`, marketId: id, name: input.noLabel, side: 'no', pricePaise: 1000 - yesPricePaise, previousPricePaise: 1000 - yesPricePaise },
      ])
      await tx.insert(marketPriceHistory).values({ id: randomUUID(), marketId: id, t: now, yesPricePaise })
    })

    // Privileged state change: attributable to the admin who made it.
    await recordAudit({
      actorRole: 'admin',
      actorUserId: admin.id,
      action: AUDIT_ACTIONS.marketCreated,
      entityType: 'market',
      entityId: id,
      summary: `Created market "${input.question.slice(0, 120)}" (status=${input.status})`,
      metadata: { category: input.categoryId, status: input.status },
    })

    return NextResponse.json({ ok: true, marketId: id })
  } catch (error) {
    return routeFailureResponse(error, {
      area: '[admin]',
      operation: 'market creation failed',
      message: 'The market could not be created. Try again.',
      invalidMessage: 'Invalid market',
    })
  }
}
