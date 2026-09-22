import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { authKeyConfigured, authKeyMissingConfig, AuthKeyError, sendSignInCode } from '@/lib/providers/authkey-otp'

const realFetch = globalThis.fetch
const KEY = 'test-authkey-secret-4d5c354f'
const SENDER = 'PREDIK'

let requests: string[] = []

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((input: unknown) => {
    const url = String(input)
    requests.push(url)
    return Promise.resolve(handler(url))
  }) as typeof fetch
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function configure() {
  process.env.AUTHKEY_API_KEY = KEY
  process.env.AUTHKEY_SENDER_ID = SENDER
}

async function failureFrom(run: () => Promise<unknown>): Promise<AuthKeyError> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof AuthKeyError, `expected an AuthKeyError, received ${String(error)}`)
    return error
  }
  throw new Error('expected the call to fail')
}

afterEach(() => {
  globalThis.fetch = realFetch
  requests = []
  delete process.env.AUTHKEY_API_KEY
  delete process.env.AUTHKEY_SENDER_ID
  delete process.env.AUTHKEY_TEMPLATE_ID
  delete process.env.AUTHKEY_OTP_VARIABLE
  delete process.env.AUTHKEY_COUNTRY_CODE
})

describe('AuthKey SMS adapter', () => {
  test('sends the code in the documented request shape', async () => {
    configure()
    stubFetch(() => jsonResponse({ Message: 'Submitted Successfully' }))

    await sendSignInCode({ phone: '9876543210', code: '135790' })

    assert.equal(requests.length, 1)
    const url = new URL(requests[0])
    assert.equal(url.origin + url.pathname, 'https://api.authkey.io/request')
    assert.equal(url.searchParams.get('authkey'), KEY)
    assert.equal(url.searchParams.get('mobile'), '9876543210')
    assert.equal(url.searchParams.get('sid'), SENDER)
    assert.equal(url.searchParams.get('country_code'), '91', 'the country code is sent separately')
    assert.equal(url.searchParams.get('otp'), '135790', 'the default template variable')
  })

  test('the sender template variable and country code are configuration, not guesses', async () => {
    configure()
    process.env.AUTHKEY_TEMPLATE_ID = 'TPL-42'
    process.env.AUTHKEY_OTP_VARIABLE = 'name'
    process.env.AUTHKEY_COUNTRY_CODE = '44'
    stubFetch(() => jsonResponse({ Message: 'Submitted Successfully' }))

    await sendSignInCode({ phone: '7700900123', code: '246810' })

    const url = new URL(requests[0])
    assert.equal(url.searchParams.get('template_id'), 'TPL-42')
    assert.equal(url.searchParams.get('name'), '246810')
    assert.equal(url.searchParams.get('country_code'), '44')
    assert.equal(url.searchParams.get('otp'), null, 'only the configured variable carries the code')
  })

  test('an invalid key is reported as an auth failure, not a generic error', async () => {
    configure()
    // The live service answers this on HTTP 203 with a Message field.
    stubFetch(() => jsonResponse({ Message: 'Invalid authkey or insufficient balance' }, 203))

    const error = await failureFrom(() => sendSignInCode({ phone: '9876543210', code: '135790' }))
    assert.equal(error.kind, 'auth')
  })

  test('an unapproved sender or template is its own failure kind', async () => {
    configure()
    stubFetch(() => jsonResponse({ Message: 'Template not approved for this sender id' }))

    const error = await failureFrom(() => sendSignInCode({ phone: '9876543210', code: '135790' }))
    assert.equal(error.kind, 'template')
  })

  test('an unrecognised reply is treated as a failure, never as success', async () => {
    configure()
    stubFetch(() => jsonResponse({ Message: 'Something new happened' }))

    const error = await failureFrom(() => sendSignInCode({ phone: '9876543210', code: '135790' }))
    assert.equal(error.kind, 'unavailable')
  })

  test('an empty 200 reply is a failure: nothing was confirmed', async () => {
    configure()
    stubFetch(() => jsonResponse({}))

    const error = await failureFrom(() => sendSignInCode({ phone: '9876543210', code: '135790' }))
    assert.equal(error.kind, 'unavailable')
  })

  test('missing configuration fails without making a request', async () => {
    stubFetch(() => jsonResponse({ Message: 'Submitted Successfully' }))

    assert.equal(authKeyConfigured(), false)
    assert.deepEqual(authKeyMissingConfig(), ['AUTHKEY_API_KEY', 'AUTHKEY_SENDER_ID'])

    const error = await failureFrom(() => sendSignInCode({ phone: '9876543210', code: '135790' }))
    assert.equal(error.kind, 'not-configured')
    assert.equal(requests.length, 0)
  })

  test('a timeout is reported, because the outcome of the send is unknown', async () => {
    configure()
    stubFetch(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    })

    const error = await failureFrom(() => sendSignInCode({ phone: '9876543210', code: '135790' }))
    assert.equal(error.kind, 'timeout')
  })

  test('a phone number or code that cannot be sent is refused before the request', async () => {
    configure()
    stubFetch(() => jsonResponse({ Message: 'Submitted Successfully' }))

    assert.equal((await failureFrom(() => sendSignInCode({ phone: 'not-a-number', code: '135790' }))).kind, 'unavailable')
    assert.equal((await failureFrom(() => sendSignInCode({ phone: '9876543210', code: 'abcd' }))).kind, 'unavailable')
    assert.equal(requests.length, 0, 'nothing is sent when the input cannot be a code')
  })

  test('neither the credential nor the code reaches a message or a log line', async () => {
    configure()
    const logged: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }

    try {
      stubFetch(() => jsonResponse({ Message: 'Invalid authkey or insufficient balance' }, 203))
      const rejected = await failureFrom(() => sendSignInCode({ phone: '9876543210', code: '135790' }))

      stubFetch(() => {
        throw Object.assign(new Error(`connect failed for https://api.authkey.io/request?authkey=${KEY}&otp=135790`), {
          name: 'FetchError',
        })
      })
      const network = await failureFrom(() => sendSignInCode({ phone: '9876543210', code: '135790' }))

      for (const text of [rejected.message, network.message, ...logged]) {
        assert.ok(!text.includes(KEY), `the credential leaked into: ${text}`)
      }
      for (const text of [rejected.message, network.message]) {
        assert.ok(!text.includes('135790'), `the one-time code leaked into: ${text}`)
      }
    } finally {
      console.error = realError
    }
  })
})
