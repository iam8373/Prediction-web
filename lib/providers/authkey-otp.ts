import 'server-only'

import { getJson, ProviderRequestError, scrubSecrets, type ProviderFailureKind } from '@/lib/providers/http'

/**
 * AuthKey — delivery of the sign-in one-time code by SMS.
 *
 * This is the only provider call that costs money per use and the only one that
 * cannot be retried freely, so it is kept small and explicit: no cache (every
 * send must go out), no batching, and the phone number and code are never
 * logged.
 *
 * Confirmed against the live service from this repository:
 *  - endpoint `https://api.authkey.io/request`
 *  - the credential is the `authkey` **query parameter**
 *  - parameters: `mobile`, `country_code`, `sid` (sender id) and a template
 *    variable
 *  - failures are returned as a **JSON body with a `Message` field**, on a
 *    non-error HTTP status: a request with a bogus key answered `HTTP 203`
 *    (which `response.ok` accepts) with
 *    `{"Message":"Invalid authkey or insufficient balance"}`. So the status
 *    cannot be trusted as the verdict and the body must be read.
 *
 * NOT confirmed, and therefore configuration rather than a hardcoded guess —
 * these belong to the operator's own AuthKey account:
 *  - `AUTHKEY_SENDER_ID` (the registered `sid`)
 *  - `AUTHKEY_TEMPLATE_ID` (sent only when set)
 *  - `AUTHKEY_OTP_VARIABLE`, the name of the template variable that carries the
 *    code (default `otp`). AuthKey templates are approved per account, and the
 *    variable name is part of the approved template, so guessing it would
 *    silently produce rejected sends.
 *  - `AUTHKEY_COUNTRY_CODE` (default `91`)
 *
 * A send that times out is reported as a failure even though the message may
 * have gone out; the caller's advice is to retry, which is the only safe
 * instruction when the outcome is unknown.
 */

const BASE_URL = 'https://api.authkey.io/request'
const TIMEOUT_MS = 5_000

export type AuthKeyFailureKind =
  | 'not-configured'
  | 'auth'
  | 'rate-limit'
  | 'template'
  | 'timeout'
  | 'network'
  | 'malformed'
  | 'unavailable'

export class AuthKeyError extends Error {
  readonly kind: AuthKeyFailureKind
  readonly status?: number

  constructor(kind: AuthKeyFailureKind, detail: string, status?: number) {
    super(`authkey ${kind}: ${detail}`)
    this.name = 'AuthKeyError'
    this.kind = kind
    this.status = status
  }
}

interface AuthKeyResponse {
  Message?: string
  Details?: string
}

export interface SignInCodeInput {
  /** National number, digits only — the country code is sent separately. */
  phone: string
  code: string
}

export function authKeyConfigured(): boolean {
  return Boolean(process.env.AUTHKEY_API_KEY?.trim() && process.env.AUTHKEY_SENDER_ID?.trim())
}

/** Names of the variables SMS delivery still needs, for the startup report. */
export function authKeyMissingConfig(): string[] {
  const missing: string[] = []
  if (!process.env.AUTHKEY_API_KEY?.trim()) missing.push('AUTHKEY_API_KEY')
  if (!process.env.AUTHKEY_SENDER_ID?.trim()) missing.push('AUTHKEY_SENDER_ID')
  return missing
}

/**
 * Sends one code. Throws `AuthKeyError`; the caller decides what the visitor
 * sees. The code is never included in an error, a log line or an audit row — the
 * `Message` returned by AuthKey is the only text that leaves this module.
 */
export async function sendSignInCode(input: SignInCodeInput): Promise<{ message: string }> {
  const key = process.env.AUTHKEY_API_KEY?.trim()
  const senderId = process.env.AUTHKEY_SENDER_ID?.trim()
  const missing = authKeyMissingConfig()
  if (!key || !senderId) throw new AuthKeyError('not-configured', `missing ${missing.join(', ')}`)

  if (!/^\d{6,15}$/.test(input.phone)) throw new AuthKeyError('unavailable', 'the phone number could not be normalised for SMS')
  if (!/^\d{4,8}$/.test(input.code)) throw new AuthKeyError('unavailable', 'the code to send is not a numeric one-time code')

  const params = new URLSearchParams({
    authkey: key,
    mobile: input.phone,
    country_code: process.env.AUTHKEY_COUNTRY_CODE?.trim() || '91',
    sid: senderId,
    // The template variable that carries the code, e.g. `otp` or `name`.
    [process.env.AUTHKEY_OTP_VARIABLE?.trim() || 'otp']: input.code,
  })
  const templateId = process.env.AUTHKEY_TEMPLATE_ID?.trim()
  if (templateId) params.set('template_id', templateId)

  let payload: AuthKeyResponse
  try {
    payload = await getJson<AuthKeyResponse>({
      provider: 'authkey',
      url: `${BASE_URL}?${params.toString()}`,
      timeoutMs: TIMEOUT_MS,
      classifyErrorBody: classifyAuthKeyBody,
    })
  } catch (error) {
    throw toAuthKeyError(error, key, input.code)
  }

  const message = scrubSecrets(payload.Message?.trim() || '', [key, senderId, input.code])
  if (!isSubmitted(message)) {
    const failure = classifyMessage(message)
    console.error(`[providers] authkey ${failure.kind}: ${failure.message}`)
    throw failure
  }

  return { message }
}

/**
 * AuthKey answers with prose, so the verdict is a match on that prose. Kept
 * generous on the success side (the documented wording varies by account) and
 * strict on the failure side: anything unrecognised is treated as a failure,
 * because signing someone in on a code that was never delivered is worse than
 * asking them to try again.
 */
function isSubmitted(message: string): boolean {
  if (!message) return false
  return /submit|success|sent|queued|accepted/i.test(message)
}

function classifyMessage(message: string): AuthKeyError {
  const lowered = message.toLowerCase()
  if (lowered.includes('authkey') || lowered.includes('invalid') || lowered.includes('balance') || lowered.includes('unauthor')) {
    return new AuthKeyError('auth', message || 'the credential was rejected')
  }
  if (lowered.includes('limit') || lowered.includes('quota') || lowered.includes('flood') || lowered.includes('throttl')) {
    return new AuthKeyError('rate-limit', message || 'the account is rate limited')
  }
  if (lowered.includes('template') || lowered.includes('sender') || lowered.includes('sid') || lowered.includes('dlt') || lowered.includes('approved')) {
    return new AuthKeyError('template', message || 'the sender id or template was rejected')
  }
  return new AuthKeyError('unavailable', message || 'the gateway reported an unknown failure')
}

function classifyAuthKeyBody(body: unknown): { kind: ProviderFailureKind; detail: string } | null {
  const message = (body as AuthKeyResponse | null)?.Message?.trim()
  if (!message) return null
  const classified = classifyMessage(message)
  const kind: ProviderFailureKind =
    classified.kind === 'auth' ? 'auth'
      : classified.kind === 'rate-limit' ? 'rate-limit'
        : 'http'
  return { kind, detail: message }
}

function toAuthKeyError(error: unknown, key: string, code: string): AuthKeyError {
  if (error instanceof AuthKeyError) return error
  // The code travels in the request URL, so an unscrubbed message would put a
  // working sign-in code into the logs. Both the credential and the code are
  // removed before the message is allowed anywhere near a log line.
  const scrub = (text: string) => scrubSecrets(text, [key, code])
  if (error instanceof ProviderRequestError) {
    const kind: AuthKeyFailureKind =
      error.kind === 'auth' ? 'auth'
        : error.kind === 'rate-limit' ? 'rate-limit'
          : error.kind === 'timeout' ? 'timeout'
            : error.kind === 'malformed' ? 'malformed'
              : 'network'
    return new AuthKeyError(kind, scrub(error.message), error.status)
  }
  return new AuthKeyError('unavailable', scrub(error instanceof Error ? error.message : 'unknown failure'))
}
