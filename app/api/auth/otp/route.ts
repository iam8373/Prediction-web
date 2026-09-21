import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { otpDeliveryChannel } from '@/lib/auth/admin'
import { createSession, getSessionCookieOptions, requestOtp, verifyOtp } from '@/lib/auth/session'
import { anonymisedClientRef, logSecurityEvent, SECURITY_EVENTS } from '@/lib/security/events'
import { assertJsonRequestBody, readJsonBody, securityErrorResponse } from '@/lib/security/guard'
import { assertTrustedRequestOrigin } from '@/lib/security/request-origin'
import { clientKey, enforceRateLimit } from '@/lib/security/rate-limit'
import { otpSchema, phoneSchema } from '@/lib/validation/schemas'

/**
 * Sign-in endpoint.
 *
 * Hardening applied here (Phase 10):
 *  - cross-site requests are refused before anything else, so a third-party page
 *    cannot drive a sign-in (login CSRF)
 *  - the phone number is validated before it is used as a rate-limit key, so
 *    unvalidated input can never mint arbitrary buckets
 *  - OTP requests are limited per IP and per phone (SMS abuse / enumeration),
 *    and verification attempts are limited per phone ACROSS challenges — the
 *    per-challenge attempt cap alone could be reset by requesting a new code
 *  - failures are recorded as security events with an anonymised client
 *    reference, and the response never discloses whether an account exists
 */
export async function POST(request: Request) {
  try {
    assertJsonRequestBody(request)
    assertTrustedRequestOrigin(request)
    const body = (await readJsonBody(request)) as { action?: string; phone?: string; otp?: string }

    if (body.action === 'request') {
      const phone = phoneSchema.parse(body.phone ?? '')
      await enforceRateLimit({ bucket: 'otpRequestIp', key: `ip:${clientKey(request)}` })
      await enforceRateLimit({ bucket: 'otpRequestPhone', key: `phone:${phone}` })

      const result = await requestOtp(phone)
      // Same response for a new and an existing account: no enumeration signal.
      // `delivery` tells the sign-in screen how to word itself — it must not say
      // a message was sent when this deployment sends none — and `demoCode` is
      // present only when the server deliberately disclosed the code.
      return NextResponse.json({ ok: true, delivery: otpDeliveryChannel(), demoCode: result.demoCode })
    }

    if (body.action === 'verify') {
      const phone = phoneSchema.parse(body.phone ?? '')
      const otp = otpSchema.parse(body.otp ?? '')
      await enforceRateLimit({ bucket: 'otpVerifyIp', key: `ip:${clientKey(request)}` })
      await enforceRateLimit({ bucket: 'otpVerifyPhone', key: `phone:${phone}` })

      const user = await verifyOtp(phone, otp)
      const token = await createSession(user.id)
      const response = NextResponse.json({ ok: true, user })
      response.cookies.set('predik_session', token, getSessionCookieOptions())
      return response
    }

    return NextResponse.json({ ok: false, error: 'Unsupported authentication action' }, { status: 400 })
  } catch (error) {
    const securityResponse = securityErrorResponse(error)
    if (securityResponse) return securityResponse

    if (error instanceof ZodError) {
      return NextResponse.json({ ok: false, error: 'Enter a valid phone number and 6 digit code.' }, { status: 400 })
    }
    if (error instanceof Error && error.message === 'OTP_UNAVAILABLE') {
      // Fail closed: a production deployment with no OTP delivery configured
      // must not sign anyone in with a fixed, documented code.
      await logSecurityEvent({
        action: SECURITY_EVENTS.otpUnavailable,
        entityType: 'otpChallenge',
        entityId: anonymisedClientRef(request),
        summary: 'Refused to issue a sign-in code: OTP delivery is not configured for this environment',
        outcome: 'denied',
        metadata: { environment: process.env.NODE_ENV ?? 'unknown' },
      })
      return NextResponse.json(
        { ok: false, error: 'Sign in is not available on this deployment yet.' },
        { status: 503 },
      )
    }

    if (error instanceof Error && error.message === 'INVALID_OTP') {
      await logSecurityEvent({
        action: SECURITY_EVENTS.otpFailed,
        entityType: 'otpChallenge',
        entityId: anonymisedClientRef(request),
        summary: 'Rejected an invalid or expired sign-in code',
        outcome: 'denied',
        metadata: { client: anonymisedClientRef(request) },
      })
      return NextResponse.json(
        { ok: false, error: 'That code did not match or has expired. Request a new one.' },
        { status: 400 },
      )
    }
    console.error('[auth] OTP request failed', error)
    return NextResponse.json({ ok: false, error: 'We could not complete sign in. Try again.' }, { status: 500 })
  }
}
