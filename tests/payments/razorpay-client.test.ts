import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PaymentProviderError } from '@/lib/payments/contracts'
import { RazorpayClient } from '@/lib/payments/razorpay/client'

/**
 * Transport tests with an injected `fetch`, so no network and no credentials
 * leave the process. They cover the rules that protect real money: the payout
 * idempotency header is always sent, a timeout is a failure (never a success),
 * provider errors are mapped to stable codes, and secrets never appear in an
 * error message.
 */

const KEY_ID = 'rzp_test_keyID12345'
const KEY_SECRET = 'rzp_test_keySecret6789'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function client(options: {
  respond: () => Response | Promise<Response> | never
  accountNumber?: string
  timeoutMs?: number
}) {
  const calls: Call[] = []
  const instance = new RazorpayClient({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    accountNumber: options.accountNumber,
    payoutMode: 'UPI',
    timeoutMs: options.timeoutMs,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init.method),
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body as string | undefined,
      })
      return options.respond() as Response
    }) as typeof fetch,
  })
  return { instance, calls }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('razorpay client transport', () => {
  it('authenticates with basic auth and never puts the secret in a URL', async () => {
    const { instance, calls } = client({ respond: () => json({ id: 'order_1', status: 'created' }) })
    await instance.createOrder({ amountPaise: 50_000, currency: 'INR', receipt: 'pay_internal' })

    assert.equal(calls.length, 1)
    const expected = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`
    assert.equal(calls[0].headers.authorization, expected)
    assert.ok(!calls[0].url.includes(KEY_SECRET))
  })

  it('sends the caller-supplied order payload with integer paise and captured payment', async () => {
    const { instance, calls } = client({ respond: () => json({ id: 'order_1' }) })
    await instance.createOrder({ amountPaise: 123_456, currency: 'INR', receipt: 'pay_1', notes: { a: 'b' } })
    const body = JSON.parse(calls[0].body ?? '{}')
    assert.equal(body.amount, 123_456)
    assert.equal(body.currency, 'INR')
    assert.equal(body.receipt, 'pay_1')
    assert.equal(body.payment_capture, 1)
  })

  it('sends the payout idempotency header on every payout request', async () => {
    const { instance, calls } = client({ respond: () => json({ id: 'pout_1' }), accountNumber: '1234567890' })
    await instance.createPayout({
      fundAccountId: 'fa_1',
      amountPaise: 20_000,
      currency: 'INR',
      idempotencyKey: 'uuid-abc',
      referenceId: 'WDL-1',
      narration: 'Predik payout',
    })
    assert.equal(calls[0].headers['X-Payout-Idempotency'], 'uuid-abc')
    const body = JSON.parse(calls[0].body ?? '{}')
    assert.equal(body.account_number, '1234567890')
    assert.equal(body.queue_if_low_balance, false)
  })

  it('refuses to create a payout without a source account configured', async () => {
    const { instance, calls } = client({ respond: () => json({}) })
    await assert.rejects(
      () => instance.createPayout({
        fundAccountId: 'fa_1',
        amountPaise: 100,
        currency: 'INR',
        idempotencyKey: 'k',
        referenceId: 'r',
        narration: 'n',
      }),
      (error: unknown) => error instanceof PaymentProviderError && error.code === 'PROVIDER_NOT_CONFIGURED',
    )
    assert.equal(calls.length, 0)
  })

  it('treats a timeout as a failure, never a success', async () => {
    const { instance } = client({
      respond: () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      },
    })
    await assert.rejects(
      () => instance.fetchPayment('pay_1'),
      (error: unknown) => error instanceof PaymentProviderError && error.code === 'PROVIDER_TIMEOUT',
    )
  })

  it('maps a connection failure to PROVIDER_UNAVAILABLE', async () => {
    const { instance } = client({
      respond: () => {
        throw new Error('fetch failed')
      },
    })
    await assert.rejects(
      () => instance.fetchPayment('pay_1'),
      (error: unknown) => error instanceof PaymentProviderError && error.code === 'PROVIDER_UNAVAILABLE',
    )
  })

  it('keeps the provider error code and redacts the credentials from the description', async () => {
    const { instance } = client({
      respond: () => json(
        { error: { code: 'BAD_REQUEST_ERROR', description: `Invalid key ${KEY_SECRET} for merchant` } },
        400,
      ),
    })
    await assert.rejects(
      () => instance.fetchPayment('pay_1'),
      (error: unknown) => {
        assert.ok(error instanceof PaymentProviderError)
        assert.equal(error.code, 'BAD_REQUEST_ERROR')
        assert.ok(!error.message.includes(KEY_SECRET))
        assert.ok(error.message.includes('[redacted]'))
        return true
      },
    )
  })

  it('falls back to an HTTP-coded error when the provider sends none', async () => {
    const { instance } = client({ respond: () => new Response('', { status: 503 }) })
    await assert.rejects(
      () => instance.fetchPayment('pay_1'),
      (error: unknown) => error instanceof PaymentProviderError && error.code === 'PROVIDER_HTTP_503',
    )
  })

  it('rejects an unreadable success response instead of guessing', async () => {
    const { instance } = client({ respond: () => new Response('<html>oops</html>', { status: 200 }) })
    await assert.rejects(
      () => instance.fetchPayment('pay_1'),
      (error: unknown) => error instanceof PaymentProviderError && error.code === 'PROVIDER_BAD_RESPONSE',
    )
  })

  it('url-encodes identifiers so a provider id cannot alter the path', async () => {
    const { instance, calls } = client({ respond: () => json({ id: 'pay_1' }) })
    await instance.fetchPayment('pay_1/../../orders')
    assert.ok(calls[0].url.endsWith('/payments/pay_1%2F..%2F..%2Forders'))
  })
})
