import { NextResponse } from 'next/server'

import { getCurrentUser } from '@/lib/auth/session'
import { listPaymentsForUser } from '@/lib/data/server-api'
import { publicPaymentConfig } from '@/lib/payments/config'
import { securityErrorResponse } from '@/lib/security/guard'
import { enforceRateLimit } from '@/lib/security/rate-limit'

/**
 * The signed-in user's payment history: deposits, withdrawals and refunds with
 * their provider reference, status, refund status and reconciliation status.
 * Extends the existing Activity/transaction architecture rather than adding a
 * second history system.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Sign in to view your payments' }, { status: 401 })

  try {
    await enforceRateLimit({ bucket: 'accountRead', key: `user:${user.id}` })
  } catch (error) {
    const mapped = securityErrorResponse(error)
    if (mapped) return mapped
    throw error
  }

  // Pagination is bounded server-side; NaN/Infinity fall back to the default.
  const requested = Number(new URL(request.url).searchParams.get('limit') ?? 50)
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 50

  const payments = await listPaymentsForUser(user.id, limit)
  return NextResponse.json({ ok: true, payments, summary: publicPaymentConfig() })
}
