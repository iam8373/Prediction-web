/**
 * Razorpay REST client.
 *
 * Everything Razorpay-specific about *transport* lives here: Basic auth, the
 * payout idempotency header, timeouts and error mapping. No other module in the
 * app knows these endpoints.
 *
 * Rules honoured here:
 *  - credentials come from the caller (which reads them from the environment),
 *    are never logged, never persisted and never placed in error messages
 *  - a request that times out is a failure, never a success: the caller keeps
 *    the payment pending and reconciliation/status lookup settles the truth
 *  - provider error bodies are reduced to code + description and redacted
 *
 * Not marked `server-only` so the transport can be unit tested with an injected
 * `fetch`; the module itself only performs HTTP and holds no state.
 */

import { PaymentProviderError } from '@/lib/payments/contracts'

export const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1'
export const DEFAULT_TIMEOUT_MS = 10_000
const MAX_ERROR_TEXT = 300

export interface RazorpayClientOptions {
  keyId: string
  keySecret: string
  /** RazorpayX source account number (customer identifier or current account). */
  accountNumber?: string
  /** Payout rail: UPI | IMPS | NEFT | RTGS. */
  payoutMode?: string
  apiBase?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Extra secrets to strip from any text that leaves this module. */
  redactSecrets?: string[]
}

export interface RazorpayEntity {
  id?: string
  entity?: string
  status?: string
  amount?: number
  amount_paid?: number
  amount_captured?: number
  currency?: string
  receipt?: string | null
  order_id?: string | null
  payment_id?: string | null
  reference_id?: string | null
  utr?: string | null
  method?: string
  short_url?: string
  notes?: Record<string, unknown> | null
  created_at?: number
  error_code?: string | null
  error_description?: string | null
  status_details?: { description?: string | null; reason?: string | null } | null
  contact_id?: string | null
  fund_account_id?: string | null
}

export interface RazorpayList<T> {
  entity: 'collection'
  count: number
  items: T[]
}

function redact(text: string, secrets: string[]) {
  let output = text
  for (const secret of secrets) {
    if (secret && secret.length >= 6) output = output.split(secret).join('[redacted]')
  }
  return output.slice(0, MAX_ERROR_TEXT)
}

export class RazorpayClient {
  private readonly options: Required<Pick<RazorpayClientOptions, 'keyId' | 'keySecret'>> & RazorpayClientOptions
  private readonly secrets: string[]

  constructor(options: RazorpayClientOptions) {
    this.options = options
    this.secrets = [options.keySecret, options.keyId, ...(options.redactSecrets ?? [])].filter(Boolean)
  }

  private get apiBase() {
    return (this.options.apiBase ?? RAZORPAY_API_BASE).replace(/\/+$/, '')
  }

  private authHeader() {
    return `Basic ${Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString('base64')}`
  }

  private async request<T>(input: {
    method: 'GET' | 'POST'
    path: string
    body?: unknown
    idempotencyKey?: string
  }): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let response: Response
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.apiBase}${input.path}`, {
        method: input.method,
        headers: {
          authorization: this.authHeader(),
          'content-type': 'application/json',
          ...(input.idempotencyKey ? { 'X-Payout-Idempotency': input.idempotencyKey } : {}),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
        cache: 'no-store',
      })
    } catch (error) {
      clearTimeout(timeout)
      const aborted = error instanceof Error && error.name === 'AbortError'
      throw new PaymentProviderError(
        aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        aborted
          ? 'The payment provider did not respond in time. The payment stays pending.'
          : 'The payment provider could not be reached. The payment stays pending.',
      )
    }
    clearTimeout(timeout)

    const raw = await response.text().catch(() => '')
    let parsed: unknown = null
    if (raw) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }

    if (!response.ok) {
      const body = parsed as { error?: { code?: string; description?: string; reason?: string; field?: string } } | null
      const providerCode = body?.error?.code && /^[A-Z_]+$/.test(body.error.code) ? body.error.code : undefined
      const description = body?.error?.description
        ?? body?.error?.reason
        ?? `The payment provider rejected the request (HTTP ${response.status})`
      // A 5xx is INDETERMINATE: the provider may have applied the request before
      // failing. It is reported as `PROVIDER_HTTP_5xx` (which the service treats
      // as indeterminate, leaving the payment pending for reconciliation) and the
      // provider's own code is kept in the message. Trusting the provider's
      // "SERVER_ERROR"-style body code here would look like a definitive
      // rejection and mark a possibly-created payment as failed.
      const code = response.status >= 500
        ? `PROVIDER_HTTP_${response.status}`
        : providerCode ?? `PROVIDER_HTTP_${response.status}`
      throw new PaymentProviderError(
        code,
        redact(response.status >= 500 && providerCode ? `${providerCode}: ${description}` : description, this.secrets),
      )
    }

    if (parsed === null) {
      throw new PaymentProviderError('PROVIDER_BAD_RESPONSE', 'The payment provider returned an unreadable response')
    }
    return parsed as T
  }

  /* --------------------------- deposits --------------------------- */

  /** Create an order. Razorpay requires a new order per payment attempt. */
  async createOrder(input: {
    amountPaise: number
    currency: string
    receipt: string
    notes?: Record<string, string>
  }) {
    return this.request<RazorpayEntity>({
      method: 'POST',
      path: '/orders',
      body: {
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes ?? {},
        payment_capture: 1,
      },
    })
  }

  /** Hosted payment link (returns a `short_url` the user can be redirected to). */
  async createPaymentLink(input: {
    amountPaise: number
    currency: string
    description: string
    referenceId: string
    callbackUrl?: string
    notes?: Record<string, string>
  }) {
    return this.request<RazorpayEntity>({
      method: 'POST',
      path: '/payment_links',
      body: {
        amount: input.amountPaise,
        currency: input.currency,
        accept_partial: false,
        description: input.description,
        reference_id: input.referenceId,
        ...(input.callbackUrl ? { callback_url: input.callbackUrl, callback_method: 'get' } : {}),
        notes: input.notes ?? {},
        reminder_enable: false,
      },
    })
  }

  async fetchPayment(paymentId: string) {
    return this.request<RazorpayEntity>({ method: 'GET', path: `/payments/${encodeURIComponent(paymentId)}` })
  }

  async fetchOrder(orderId: string) {
    return this.request<RazorpayEntity>({ method: 'GET', path: `/orders/${encodeURIComponent(orderId)}` })
  }

  async listPayments(input: { fromSeconds: number; toSeconds: number; count: number }) {
    const query = new URLSearchParams({
      from: String(input.fromSeconds),
      to: String(input.toSeconds),
      count: String(input.count),
    })
    return this.request<RazorpayList<RazorpayEntity>>({ method: 'GET', path: `/payments?${query.toString()}` })
  }

  async createRefund(input: {
    paymentId: string
    amountPaise: number
    receipt: string
    notes?: Record<string, string>
  }) {
    return this.request<RazorpayEntity>({
      method: 'POST',
      path: `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      body: {
        amount: input.amountPaise,
        speed: 'optimum',
        receipt: input.receipt,
        notes: input.notes ?? {},
      },
    })
  }

  async fetchRefund(refundId: string) {
    return this.request<RazorpayEntity>({ method: 'GET', path: `/refunds/${encodeURIComponent(refundId)}` })
  }

  /* --------------------------- payouts ---------------------------- */

  async createContact(input: { name: string; referenceId: string; email?: string; contact?: string }) {
    return this.request<RazorpayEntity>({
      method: 'POST',
      path: '/contacts',
      body: {
        name: input.name,
        type: 'customer',
        reference_id: input.referenceId,
        ...(input.email ? { email: input.email } : {}),
        ...(input.contact ? { contact: input.contact } : {}),
      },
    })
  }

  async createFundAccount(input: { contactId: string; vpa: string }) {
    return this.request<RazorpayEntity>({
      method: 'POST',
      path: '/fund_accounts',
      body: {
        contact_id: input.contactId,
        account_type: 'vpa',
        vpa: { address: input.vpa },
      },
    })
  }

  /**
   * Create a payout. The idempotency header is mandatory for RazorpayX, and is
   * the provider-side guarantee that a retried request cannot pay twice.
   */
  async createPayout(input: {
    fundAccountId: string
    amountPaise: number
    currency: string
    idempotencyKey: string
    referenceId: string
    narration: string
    notes?: Record<string, string>
  }) {
    if (!this.options.accountNumber) {
      throw new PaymentProviderError(
        'PROVIDER_NOT_CONFIGURED',
        'Payouts need PAYMENTS_RAZORPAY_PAYOUT_ACCOUNT_NUMBER (the RazorpayX source account)',
      )
    }
    return this.request<RazorpayEntity>({
      method: 'POST',
      path: '/payouts',
      idempotencyKey: input.idempotencyKey,
      body: {
        account_number: this.options.accountNumber,
        fund_account_id: input.fundAccountId,
        amount: input.amountPaise,
        currency: input.currency,
        mode: (this.options.payoutMode ?? 'UPI').toUpperCase(),
        purpose: 'payout',
        queue_if_low_balance: false,
        reference_id: input.referenceId,
        narration: input.narration.slice(0, 30),
        notes: input.notes ?? {},
      },
    })
  }

  async fetchPayout(payoutId: string) {
    return this.request<RazorpayEntity>({ method: 'GET', path: `/payouts/${encodeURIComponent(payoutId)}` })
  }

  async cancelPayout(payoutId: string, idempotencyKey: string) {
    return this.request<RazorpayEntity>({
      method: 'POST',
      path: `/payouts/${encodeURIComponent(payoutId)}/cancel`,
      idempotencyKey,
      body: {},
    })
  }
}

export function createRazorpayClient(options: RazorpayClientOptions) {
  return new RazorpayClient(options)
}
