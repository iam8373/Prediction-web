import 'server-only'

import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { logSecurityEvent, SECURITY_EVENTS } from '@/lib/security/events'
import { assertTrustedRequestOrigin, CrossOriginRequestError } from '@/lib/security/request-origin'
import { enforceRateLimit, RateLimitExceededError, type RateLimitBucket } from '@/lib/security/rate-limit'

/**
 * The one place that decides whether a request may continue.
 *
 * Order is deliberate and matches the hardened request pipeline:
 *
 *   input validation (zod, in the route)
 *     -> authentication (session cookie, in the route)
 *       -> authorization (role checks, in the route)
 *         -> ORIGIN CHECK + RATE LIMIT   <-- this module
 *           -> business logic
 *
 * Both checks are server-side and independent of any client state. Rejections
 * are recorded as security events with a safe client reference, and the caller
 * maps the thrown coded error with `securityErrorResponse`.
 */

export interface GuardInput {
  request: Request
  /** Which budget to charge. */
  bucket?: RateLimitBucket
  /** Identity the budget belongs to (session user id, or phone/IP pre-auth). */
  key?: string
  /** Skip the cross-site check (e.g. signature-authenticated provider callbacks). */
  skipOriginCheck?: boolean
  /** Override the default request-body ceiling. */
  maxBytes?: number
  /** Skip the JSON content-type requirement (signature-verified callbacks). */
  allowNonJsonBody?: boolean
  /** Extra context for the security log. */
  scope?: string
}

export async function guardRequest(input: GuardInput): Promise<void> {
  // Cheapest rejection first: refuse an oversized declared body before reading
  // any of it. Every JSON route in this app is small, so one shared ceiling is
  // both a payload guard and a memory guard.
  assertRequestSize(input.request, input.maxBytes ?? MAX_JSON_BODY_BYTES)
  assertJsonRequestBody(input.request, { allowNonJson: input.allowNonJsonBody })

  if (!input.skipOriginCheck) assertTrustedRequestOrigin(input.request)

  if (input.bucket && input.key) {
    await enforceRateLimit({ bucket: input.bucket, key: input.key })
  }
}

/** 64 KiB: far above any legitimate JSON request this API accepts. */
export const MAX_JSON_BODY_BYTES = 64 * 1024

/** Thrown when a request declares a body larger than the ceiling; mapped to 413. */
export class PayloadTooLargeError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super('PAYLOAD_TOO_LARGE')
    this.name = 'PayloadTooLargeError'
    this.limit = limit
  }
}

/**
 * Rejects an oversized request from its declared `Content-Length`.
 *
 * `Content-Length` is client-supplied, so this is not a substitute for the
 * per-route length checks (the webhook endpoint re-checks the buffered body).
 * It is the cheap first line: an honest client's oversized body never gets read,
 * and a lying client still hits the buffered-body limit.
 */
export function assertRequestSize(request: Request, limit = MAX_JSON_BODY_BYTES): void {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) throw new PayloadTooLargeError(limit)
}

/** Thrown when a JSON endpoint is addressed with another content type; mapped to 415. */
export class UnsupportedMediaTypeError extends Error {
  readonly contentType: string | null

  constructor(contentType: string | null) {
    super('UNSUPPORTED_MEDIA_TYPE')
    this.name = 'UnsupportedMediaTypeError'
    this.contentType = contentType
  }
}

const JSON_CONTENT_TYPE = /^application\/(?:json|[a-z0-9.+-]+\+json)\s*(?:;|$)/i

/** Thrown when a body cannot be read as JSON; mapped to 400. */
export class InvalidRequestBodyError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super('INVALID_REQUEST_BODY')
    this.name = 'InvalidRequestBodyError'
    this.detail = detail
  }
}

/**
 * Reads and parses a JSON request body with a HARD byte ceiling.
 *
 * `Content-Length` is client-supplied, so `assertRequestSize` alone cannot stop
 * a chunked or streamed body: an attacker simply omits the header (or lies) and
 * streams unbounded data into memory. This reads the stream itself, aborts as
 * soon as the real byte count crosses the limit, and only then parses.
 *
 * It also turns malformed JSON into a coded client error instead of letting a
 * `SyntaxError` fall through to a generic 500 and get logged as an internal
 * fault.
 */
export async function readJsonBody(
  request: Request,
  input: { limit?: number; emptyFallback?: unknown } = {},
): Promise<unknown> {
  const limit = input.limit ?? MAX_JSON_BODY_BYTES
  assertRequestSize(request, limit)
  const raw = await readBoundedText(request, limit)
  if (raw.trim().length === 0) {
    if ('emptyFallback' in input) return input.emptyFallback
    throw new InvalidRequestBodyError('empty')
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new InvalidRequestBodyError('malformed-json')
  }
}

/** Streams the body, refusing as soon as more than `limit` bytes have arrived. */
async function readBoundedText(request: Request, limit: number): Promise<string> {
  const body = request.body
  if (!body) return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new PayloadTooLargeError(limit)
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The reader is already released/errored; nothing to clean up.
    }
  }
  // Byte length, not code units: one code point can be several UTF-8 bytes.
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/**
 * Requires a JSON content type on any request that carries a body.
 *
 * Two reasons this is not cosmetic:
 *
 *  1. A browser can submit a cross-site HTML form (`application/x-www-form-
 *     urlencoded`, `multipart/form-data`, `text/plain`) with no preflight at
 *     all. Those are exactly the classic CSRF content types, and they are
 *     pointless against this API — every mutating endpoint speaks JSON. Refusing
 *     them removes the whole simple-request class rather than relying on the
 *     origin check alone.
 *  2. It turns "wrong content type" into an explicit 415 instead of a JSON parse
 *     failure deep inside a route, which reads as a server error.
 *
 * Content type is client-supplied and therefore never an authorization control:
 * it is a shape check, and the signature/origin/rate-limit checks still apply.
 */
export function assertJsonRequestBody(request: Request, input: { allowNonJson?: boolean } = {}): void {
  if (input.allowNonJson) return
  const method = request.method.toUpperCase()
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') return

  const contentType = request.headers.get('content-type')
  const declaredLength = Number(request.headers.get('content-length') ?? '')
  const hasBody = (Number.isFinite(declaredLength) && declaredLength > 0) || Boolean(request.headers.get('transfer-encoding'))
  if (!contentType && !hasBody) return // e.g. a bodyless sign-out
  if (contentType && JSON_CONTENT_TYPE.test(contentType.trim())) return
  throw new UnsupportedMediaTypeError(contentType)
}

/** Maps a guard rejection onto an HTTP response, or returns null for other errors. */
export function securityErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof RateLimitExceededError) {
    void logSecurityEvent({
      action: SECURITY_EVENTS.rateLimited,
      entityType: 'rateLimit',
      entityId: `${error.bucket}:${error.decision.resetAt}`,
      summary: `Rate limit exceeded for ${error.bucket} (${error.decision.count}/${error.decision.limit})`,
      outcome: 'throttled',
      metadata: { bucket: error.bucket, limit: error.decision.limit, count: error.decision.count },
    })
    return NextResponse.json(
      { ok: false, error: 'Too many requests. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
    )
  }

  if (error instanceof PayloadTooLargeError) {
    return NextResponse.json({ ok: false, error: 'That request was too large.' }, { status: 413 })
  }

  if (error instanceof UnsupportedMediaTypeError) {
    return NextResponse.json({ ok: false, error: 'This endpoint expects a JSON request body.' }, { status: 415 })
  }

  if (error instanceof InvalidRequestBodyError) {
    return NextResponse.json(
      { ok: false, error: error.detail === 'empty' ? 'A request body is required.' : 'The request body was not valid JSON.' },
      { status: 400 },
    )
  }

  // A body that is not valid JSON is a client error, not a server fault. Without
  // this, malformed input fell through to the generic 500 handler and was logged
  // as an internal failure.
  if (error instanceof SyntaxError && /json/i.test(error.message)) {
    return NextResponse.json({ ok: false, error: 'The request body was not valid JSON.' }, { status: 400 })
  }

  if (error instanceof CrossOriginRequestError) {
    void logSecurityEvent({
      action: SECURITY_EVENTS.originRejected,
      entityType: 'httpRequest',
      entityId: error.origin ?? 'unknown',
      summary: 'Rejected a state-changing request from an untrusted origin',
      outcome: 'denied',
      metadata: { origin: error.origin ?? null },
    })
    return NextResponse.json({ ok: false, error: 'This request was blocked for security reasons.' }, { status: 403 })
  }

  return null
}

export interface RouteFailure {
  /** Short area label for the log line, e.g. `[watchlist]`. */
  area: string
  /** What the route was attempting, for the log line, e.g. `update failed`. */
  operation: string
  /** Message returned when the failure is genuinely unexpected. */
  message: string
  /** Message returned when input validation rejects the request. */
  invalidMessage?: string
  /**
   * Coded domain errors this route raises on purpose, mapped onto a response.
   * Keeping them here (rather than in a second catch chain) is what lets the
   * whole catch block be one call.
   */
  coded?: Record<string, { message: string; status: number }>
}

/**
 * Maps a route's caught error onto its HTTP response.
 *
 * Every non-money route used to repeat the same catch block and the copies
 * drifted — some logged, some did not, and the log line was the only place the
 * cause of an unexpected 500 survived. One helper keeps the order identical
 * everywhere:
 *
 *   1. a guard rejection (rate limit, cross-site, payload, media type, JSON body)
 *   2. input validation, which is always the client's fault
 *   3. a coded domain error the route raised deliberately
 *   4. an unexpected failure: logged in full server-side, answered with a
 *      message that is safe to show a user and reveals nothing internal
 */
export function routeFailureResponse(error: unknown, failure: RouteFailure): NextResponse {
  const security = securityErrorResponse(error)
  if (security) return security

  if (error instanceof ZodError) {
    return NextResponse.json(
      { ok: false, error: error.issues[0]?.message ?? failure.invalidMessage ?? 'That request was not valid.' },
      { status: 400 },
    )
  }

  if (failure.coded) {
    const coded = failure.coded[error instanceof Error ? error.message : '']
    if (coded) return NextResponse.json({ ok: false, error: coded.message }, { status: coded.status })
  }

  console.error(`${failure.area} ${failure.operation}`, error)
  return NextResponse.json({ ok: false, error: failure.message }, { status: 500 })
}

/**
 * Records a failed authentication/authorization attempt. Used by routes and by
 * the session helper so the "who tried to do what and was refused" trail exists
 * independently of the request log.
 */
export async function logDeniedRequest(input: {
  action: (typeof SECURITY_EVENTS)[keyof typeof SECURITY_EVENTS]
  userId?: string
  path: string
  reason: string
  metadata?: Record<string, unknown>
}) {
  await logSecurityEvent({
    action: input.action,
    actorRole: input.userId ? 'user' : 'system',
    actorUserId: input.userId,
    entityType: 'httpRequest',
    entityId: input.path.slice(0, 120),
    summary: input.reason,
    outcome: 'denied',
    metadata: input.metadata,
  })
}
