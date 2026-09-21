import { NextResponse } from 'next/server'

import { describePaymentError } from '@/lib/payments/errors'
import { auditWalletAgainstLedger } from '@/lib/payments/reconciliation'
import { requireAdmin } from '@/lib/security/admin-guard'

/**
 * Accounting reconciliation for one account (admin only).
 *
 * Answers "does the wallet hold exactly what its ledger says it should?":
 *
 *   completed ledger movements + reserved (pending) movements
 *     == available + locked
 *
 * Read only. A difference is reported with its components so it can be
 * investigated — balances are never adjusted to make the numbers agree.
 */
export async function GET(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'accountRead', scope: 'admin.payments.walletAudit' })
  if (!guard.ok) return guard.response

  const userId = new URL(request.url).searchParams.get('userId')?.trim()
  if (!userId) return NextResponse.json({ ok: false, error: 'A user id is required' }, { status: 400 })

  try {
    const audit = await auditWalletAgainstLedger(userId)
    return NextResponse.json({ ok: true, audit })
  } catch (error) {
    const mapped = describePaymentError(error)
    if (mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status })
    console.error('[payments] wallet audit failed', error)
    return NextResponse.json({ ok: false, error: 'The wallet audit could not be completed' }, { status: 500 })
  }
}
