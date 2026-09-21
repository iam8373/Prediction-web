import { NextResponse } from 'next/server'

import { getRefundableTransactions } from '@/lib/data/server-api'
import { requireAdmin } from '@/lib/security/admin-guard'

export async function GET(request: Request) {
  const guard = await requireAdmin(request, { bucket: 'accountRead', scope: 'admin.transactions.list' })
  if (!guard.ok) return guard.response

  const query = new URL(request.url).searchParams.get('query') ?? ''
  const transactions = await getRefundableTransactions(query)
  return NextResponse.json({ ok: true, transactions })
}
