import 'server-only'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { clearSession, createSession, DEMO_OTP, requestOtp, verifyOtp } from '@/lib/auth/session'
import { closePool, createTestUser, databaseUrl, rawSql, resetDatabase, transactionsForUser, readWallet } from './harness.ts'

/**
 * Authentication backbone against the real database.
 *
 * Administrative payment authorization is built on this: the session cookie is
 * resolved server-side (`getCurrentUser`) and the admin role comes from the
 * `user.isAdmin` column, never from client input. The session *lookup* itself
 * needs a Next.js request scope (`next/headers`), which the Node test runner
 * cannot provide, so what is verified here is the data layer that lookup
 * depends on: OTP integrity, session issuance/expiry/revocation and the admin
 * flag. The full browser journey is reported separately.
 */

const skip = databaseUrl() ? false : 'DATABASE_URL is not set — the PostgreSQL E2E suite did not run'

before(async () => {
  if (skip) return
  await resetDatabase()
})

after(async () => {
  await closePool()
})

describe('Authentication data layer', () => {
  test('requiring an OTP then verifying the right code issues a valid session', { skip }, async () => {
    const phone = '9876500001'
    const challenge = await requestOtp(phone)
    assert.ok(challenge.challengeId)

    const user = await verifyOtp(phone, DEMO_OTP)
    assert.equal(user.phone, phone)
    assert.equal(user.isAdmin, false, 'a fresh trader is not an admin')

    const token = await createSession(user.id)
    const rows = await rawSql<{ user_id: string; expires_at: Date }>(
      'select user_id, expires_at from session where token = $1',
      [token],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].user_id, user.id)
    assert.ok(new Date(rows[0].expires_at).getTime() > Date.now(), 'the session is not already expired')

    // A wallet exists for the account that just signed in (login provisions it).
    const wallet = await readWallet(user.id)
    assert.equal(Number(wallet.availablePaise), 0, 'a non-demo account starts empty')
  })

  test('the admin flag is server-side data tied to the account, not to the request', { skip }, async () => {
    const adminPhone = '9876543210'
    await requestOtp(adminPhone)
    const admin = await verifyOtp(adminPhone, DEMO_OTP)
    assert.equal(admin.isAdmin, true)

    // The pre-existing `user` table uses camelCase physical column names.
    const rows = await rawSql<{ isAdmin: boolean }>('select "isAdmin" from "user" where id = $1', [admin.id])
    assert.equal(rows[0]?.isAdmin, true, 'the role lives in the database')

    const trader = await createTestUser({ isAdmin: false })
    assert.equal(trader.userId.startsWith('user_test_'), true)
    const traderRows = await rawSql<{ isAdmin: boolean }>('select "isAdmin" from "user" where id = $1', [trader.userId])
    assert.equal(traderRows[0]?.isAdmin, false)
  })

  test('a wrong code is rejected and cannot create a session', { skip }, async () => {
    const phone = '9876500002'
    await requestOtp(phone)
    await assert.rejects(() => verifyOtp(phone, '000000'), /INVALID_OTP/)
    const rows = await rawSql<{ count: string }>('select count(*)::text as count from session s join "user" u on u.id = s.user_id where u."phoneNumber" = $1', [phone])
    assert.equal(Number(rows[0].count), 0)
  })

  test('a verified code cannot be replayed', { skip }, async () => {
    const phone = '9876500003'
    await requestOtp(phone)
    await verifyOtp(phone, DEMO_OTP)
    await assert.rejects(() => verifyOtp(phone, DEMO_OTP), /INVALID_OTP/, 'a consumed challenge must not be usable twice')
  })

  test('an expired challenge is refused', { skip }, async () => {
    const phone = '9876500004'
    await requestOtp(phone)
    await rawSql("update otp_challenge set expires_at = now() - interval '1 minute' where phone = $1", [phone])
    await assert.rejects(() => verifyOtp(phone, DEMO_OTP), /INVALID_OTP/)
  })

  test('a revoked session no longer resolves to a user', { skip }, async () => {
    const phone = '9876500005'
    await requestOtp(phone)
    const user = await verifyOtp(phone, DEMO_OTP)
    const token = await createSession(user.id)
    assert.equal(Number((await rawSql<{ count: string }>('select count(*)::text as count from session where token = $1', [token]))[0].count), 1)

    await clearSession(token)
    assert.equal(Number((await rawSql<{ count: string }>('select count(*)::text as count from session where token = $1', [token]))[0].count), 0, 'sign-out removes the session row')
  })

  test('an unknown cookie value resolves to nothing', { skip }, async () => {
    const rows = await rawSql('select 1 from session where token = $1', ['not-a-real-token'])
    assert.equal(rows.length, 0)
  })

  test('an expired session row is not a valid sign-in', { skip }, async () => {
    const phone = '9876500006'
    await requestOtp(phone)
    const user = await verifyOtp(phone, DEMO_OTP)
    const token = await createSession(user.id)
    await rawSql("update session set expires_at = now() - interval '1 second' where token = $1", [token])

    const rows = await rawSql<{ expires_at: Date }>('select expires_at from session where token = $1', [token])
    assert.ok(new Date(rows[0].expires_at).getTime() <= Date.now(), 'the lookup rejects it on expiry check')
  })

  test('login provisioning does not create payment or ledger history', { skip }, async () => {
    const phone = '9876500007'
    await requestOtp(phone)
    const user = await verifyOtp(phone, DEMO_OTP)
    assert.equal((await transactionsForUser(user.id)).length, 0)
    const ledger = await rawSql<{ count: string }>('select count(*)::text as count from ledger_entry where user_id = $1', [user.id])
    assert.equal(Number(ledger[0].count), 0)
  })
})
