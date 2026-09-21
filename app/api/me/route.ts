import { NextResponse } from 'next/server'

import { getCurrentUser } from '@/lib/auth/session'
import { getAccountSnapshot } from '@/lib/data/server-api'
import { securityErrorResponse } from '@/lib/security/guard'
import { enforceRateLimit } from '@/lib/security/rate-limit'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ user: null }, { status: 401 })

  try {
    // The account snapshot is an expensive read; budget it per account.
    await enforceRateLimit({ bucket: 'accountRead', key: `user:${user.id}` })
  } catch (error) {
    const mapped = securityErrorResponse(error)
    if (mapped) return mapped
    throw error
  }

  const account = await getAccountSnapshot(user.id)
  return NextResponse.json({ user, ...account })
}
