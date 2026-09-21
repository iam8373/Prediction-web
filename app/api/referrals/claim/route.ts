import { and, eq, isNull, sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { getCurrentUser } from '@/lib/auth/session'
import { db } from '@/lib/db'
import { ledgerEntries, notifications, referrals, transactions, wallets } from '@/lib/db/schema'
import { guardRequest, readJsonBody, routeFailureResponse } from '@/lib/security/guard'
import { lockResource } from '@/lib/trading/transaction-guards'

const claimSchema = z.object({ code: z.string().trim().min(6).max(32) })
const REWARD_PAISE = 5_000

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to claim an invite' }, { status: 401 })

  try {
    // Bonus credits are free money: throttle per account and refuse cross-site calls.
    await guardRequest({ request, bucket: 'referralClaim', key: `user:${user.id}`, scope: 'referrals.claim' })
    const input = claimSchema.parse(await readJsonBody(request))
    const code = input.code.toUpperCase()

    await db.transaction(async (tx) => {
      await lockResource(tx, 'referral', code)
      const [referral] = await tx
        .select()
        .from(referrals)
        .where(and(eq(referrals.code, code), isNull(referrals.referredUserId)))
        .for('update')
        .limit(1)
      if (!referral) throw new Error('INVITE_UNAVAILABLE')
      if (referral.referrerUserId === user.id) throw new Error('OWN_INVITE')

      const now = Date.now()
      const updated = await tx
        .update(referrals)
        .set({ referredUserId: user.id, status: 'claimed', rewardPaise: REWARD_PAISE, claimedAt: now })
        .where(and(eq(referrals.id, referral.id), isNull(referrals.referredUserId)))
        .returning({ id: referrals.id })
      if (updated.length === 0) throw new Error('INVITE_UNAVAILABLE')

      const nextCode = `PREDIK${referral.referrerUserId.replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`
      await tx.insert(referrals).values({
        id: `referral_${referral.referrerUserId}_${randomUUID()}`,
        referrerUserId: referral.referrerUserId,
        code: nextCode,
        status: 'pending',
        rewardPaise: 0,
        createdAt: now,
      })

      const [referrerWallet] = await tx
        .update(wallets)
        .set({ bonusPaise: sql`${wallets.bonusPaise} + ${REWARD_PAISE}`, updatedAt: new Date() })
        .where(eq(wallets.userId, referral.referrerUserId))
        .returning({ userId: wallets.userId })
      const [referredWallet] = await tx
        .update(wallets)
        .set({ bonusPaise: sql`${wallets.bonusPaise} + ${REWARD_PAISE}`, updatedAt: new Date() })
        .where(eq(wallets.userId, user.id))
        .returning({ userId: wallets.userId })
      if (!referrerWallet || !referredWallet) throw new Error('ACCOUNT_NOT_READY')

      const referrerTransactionId = randomUUID()
      const referredTransactionId = randomUUID()
      const referrerReference = `REF-${referral.id.slice(-8).toUpperCase()}-R`
      const referredReference = `REF-${referral.id.slice(-8).toUpperCase()}-U`
      const referrerDescription = 'Referral reward credited'
      const referredDescription = 'Welcome referral bonus'

      await tx.insert(transactions).values([
        { id: referrerTransactionId, userId: referral.referrerUserId, reference: referrerReference, type: 'bonus', amountPaise: REWARD_PAISE, status: 'completed', description: referrerDescription, createdAt: now },
        { id: referredTransactionId, userId: user.id, reference: referredReference, type: 'bonus', amountPaise: REWARD_PAISE, status: 'completed', description: referredDescription, createdAt: now },
      ])
      await tx.insert(ledgerEntries).values([
        { id: `ledger_${referrerTransactionId}`, userId: referral.referrerUserId, reference: referrerReference, type: 'bonus', amountPaise: REWARD_PAISE, status: 'completed', description: referrerDescription, createdAt: now },
        { id: `ledger_${referredTransactionId}`, userId: user.id, reference: referredReference, type: 'bonus', amountPaise: REWARD_PAISE, status: 'completed', description: referredDescription, createdAt: now },
      ])
      await tx.insert(notifications).values([
        { id: `notification_${referrerTransactionId}`, userId: referral.referrerUserId, eventKey: `referral:${referral.id}:referrer`, kind: 'account', title: 'Referral reward credited', description: referrerDescription, href: '/referral', createdAt: now },
        { id: `notification_${referredTransactionId}`, userId: user.id, eventKey: `referral:${referral.id}:referred`, kind: 'account', title: 'Welcome bonus credited', description: referredDescription, href: '/wallet', createdAt: now },
      ]).onConflictDoNothing()
    })

    return NextResponse.json({ ok: true, rewardPaise: REWARD_PAISE })
  } catch (error) {
    return routeFailureResponse(error, {
      area: '[referrals]',
      operation: 'claim failed',
      message: 'The invite could not be claimed. Try again.',
      invalidMessage: 'Enter a valid invite code',
      coded: {
        INVITE_UNAVAILABLE: { message: 'That invite code is unavailable or already claimed', status: 409 },
        OWN_INVITE: { message: 'You cannot claim your own invite code', status: 400 },
        ACCOUNT_NOT_READY: { message: 'Your referral wallet is not ready yet', status: 409 },
      },
    })
  }
}
