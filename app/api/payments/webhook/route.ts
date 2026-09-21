import { NextResponse } from 'next/server'

import { MAX_WEBHOOK_BYTES, handleProviderWebhook } from '@/lib/payments/webhook'
import { securityErrorResponse } from '@/lib/security/guard'
import { clientKey, enforceRateLimit } from '@/lib/security/rate-limit'

/**
 * Provider webhook endpoint: POST /api/payments/webhook
 *
 * The raw body is read before parsing because the signature is computed over
 * the exact bytes the provider sent. Nothing here trusts the payload: the
 * provider adapter verifies authenticity first, then the webhook core applies
 * the event idempotently.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function headerRecord(headers: Headers) {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value
  })
  return record
}

export async function POST(request: Request) {
  // Abuse protection BEFORE the body is buffered: an unauthenticated flood must
  // not be able to make the server allocate large strings or write rows.
  // Origin checks are deliberately skipped — a provider callback is cross-site
  // by nature and its authenticity is established by the signature, not by an
  // Origin header.
  try {
    await enforceRateLimit({ bucket: 'webhook', key: `ip:${clientKey(request)}` })
  } catch (error) {
    const mapped = securityErrorResponse(error)
    if (mapped) return mapped
    throw error
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ ok: false, error: 'Webhook payload too large' }, { status: 413 })
  }

  const providerId = request.headers.get('x-predik-provider') ?? new URL(request.url).searchParams.get('provider')
  const rawBody = await request.text()

  if (rawBody.length > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ ok: false, error: 'Webhook payload too large' }, { status: 413 })
  }

  try {
    const result = await handleProviderWebhook({
      providerId,
      rawBody,
      headers: headerRecord(request.headers),
    })
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    console.error('[payments] webhook handler error', error)
    return NextResponse.json({ ok: false, error: 'Webhook could not be processed' }, { status: 500 })
  }
}
