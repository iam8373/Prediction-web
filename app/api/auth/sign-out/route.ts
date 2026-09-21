import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

import { clearSession, getSessionCookieOptions, SESSION_COOKIE } from '@/lib/auth/session'
import { SECURITY_EVENTS } from '@/lib/security/events'
import { logDeniedRequest } from '@/lib/security/guard'
import { CrossOriginRequestError, assertTrustedRequestOrigin } from '@/lib/security/request-origin'

export async function POST(request: Request) {
  try {
    // Sign-out is state-changing: a cross-site page must not be able to log a
    // user out. The check happens before the session is touched.
    assertTrustedRequestOrigin(request)
  } catch (error) {
    if (error instanceof CrossOriginRequestError) {
      await logDeniedRequest({
        action: SECURITY_EVENTS.originRejected,
        path: '/api/auth/sign-out',
        reason: 'Sign-out attempted from an untrusted origin',
        metadata: { origin: error.origin ?? null },
      })
      return NextResponse.json({ ok: false, error: 'This request was blocked for security reasons.' }, { status: 403 })
    }
    throw error
  }

  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  await clearSession(token)

  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, '', { ...getSessionCookieOptions(), maxAge: 0 })
  return response
}
