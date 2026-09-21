import { NextResponse } from 'next/server'

import { getAllMarkets } from '@/lib/data/server-api'
import { securityErrorResponse } from '@/lib/security/guard'
import { clientKey, enforceRateLimit } from '@/lib/security/rate-limit'

/**
 * Public market snapshot. Unauthenticated by design, so the abuse budget is
 * keyed on the client address: this endpoint rebuilds the whole catalogue on
 * every call and must not be usable as a cheap amplifier.
 */
export async function GET(request: Request) {
  try {
    await enforceRateLimit({ bucket: 'accountRead', key: `ip:${clientKey(request)}` })
  } catch (error) {
    const mapped = securityErrorResponse(error)
    if (mapped) return mapped
    throw error
  }

  const markets = await getAllMarkets()
  return NextResponse.json({ markets })
}
