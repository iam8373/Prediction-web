import 'server-only'

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { cookies } from 'next/headers'

import { DEMO_OTP, isConfiguredAdminPhone, resolveOtpCode } from '@/lib/auth/admin'
import { db } from '@/lib/db'
import { otpChallenges, sessions, users } from '@/lib/db/schema'
import { ensureDemoCatalog, ensureUserAccount } from '@/lib/db/seed'
import { otpSchema, phoneSchema } from '@/lib/validation/schemas'
import type { SessionUser } from '@/types'

export const SESSION_COOKIE = 'predik_session'
/** Re-exported for existing callers/tests; the value itself now lives in `admin.ts`. */
export { DEMO_OTP }
const OTP_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_OTP_ATTEMPTS = 5

function hashCode(code: string) {
  return createHash('sha256').update(code).digest('hex')
}

function toSessionUser(user: typeof users.$inferSelect): SessionUser {
  return {
    id: user.id,
    name: user.name,
    phone: user.phoneNumber ?? '',
    avatarColor: user.avatarColor,
    isAdmin: user.isAdmin,
    joinedAt: user.createdAt.getTime(),
  }
}

function cookieOptions() {
  const crossSitePreview = Boolean(
    process.env.V0_RUNTIME_URL || process.env.V0_DEV_APP_URL || process.env.V0_BUILD_URL || process.env.V0_SANDBOX_URL,
  )
  const secure = process.env.NODE_ENV === 'production' || crossSitePreview
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? ('none' as const) : ('lax' as const),
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  }
}

export function getSessionCookieOptions() {
  return cookieOptions()
}

export async function requestOtp(phoneInput: string) {
  const phone = phoneSchema.parse(phoneInput)

  // Which code may this deployment issue? In production, an unconfigured
  // deployment must refuse to sign anyone in rather than hand out a code that is
  // identical for every account and documented in the README.
  const decision = resolveOtpCode()
  if (decision.mode === 'unavailable' || !decision.code) throw new Error('OTP_UNAVAILABLE')
  const code = decision.code

  const challengeId = randomUUID()
  const now = new Date()

  await db.transaction(async (tx) => {
    // Supersede any outstanding code for this number. Only the newest code can
    // ever be accepted, so an attacker cannot keep a large pool of live
    // challenges in play, and a re-requested code invalidates the previous one.
    await tx
      .update(otpChallenges)
      .set({ consumedAt: now })
      .where(and(eq(otpChallenges.phone, phone), isNull(otpChallenges.consumedAt)))

    await tx.insert(otpChallenges).values({
      id: challengeId,
      phone,
      codeHash: hashCode(code),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    })
  })

  return {
    challengeId,
    // Only the development demo mode echoes the code back (it is shown on the
    // sign-in screen). A configured production code is never disclosed.
    demoCode: decision.disclose ? code : undefined,
  }
}

export async function verifyOtp(phoneInput: string, otpInput: string) {
  const phone = phoneSchema.parse(phoneInput)
  const otp = otpSchema.parse(otpInput)
  const now = new Date()

  const user = await db.transaction(async (tx) => {
    const challenge = await tx
      .select()
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phone), isNull(otpChallenges.consumedAt)))
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1)

    const current = challenge[0]
    if (!current || current.expiresAt <= now || current.attempts >= MAX_OTP_ATTEMPTS) {
      throw new Error('INVALID_OTP')
    }

    const expected = Buffer.from(current.codeHash)
    const actual = Buffer.from(hashCode(otp))
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await tx.update(otpChallenges)
        .set({ attempts: sql`${otpChallenges.attempts} + 1` })
        .where(eq(otpChallenges.id, current.id))
      throw new Error('INVALID_OTP')
    }

    const consumed = await tx.update(otpChallenges)
      .set({ consumedAt: now })
      .where(and(eq(otpChallenges.id, current.id), isNull(otpChallenges.consumedAt)))
      .returning({ id: otpChallenges.id })
    if (consumed.length === 0) throw new Error('INVALID_OTP')

    const existing = await tx.select().from(users).where(eq(users.phoneNumber, phone)).limit(1)
    if (existing[0]) {
      // Admin privilege is granted from configuration (`ADMIN_PHONES`), never
      // from a literal phone number in source. This keeps the allowlist
      // authoritative on every sign-in and is idempotent; privilege is never
      // revoked here, because that is an explicit administrative action.
      if (isConfiguredAdminPhone(phone) && !existing[0].isAdmin) {
        const [elevated] = await tx.update(users).set({ isAdmin: true }).where(eq(users.id, existing[0].id)).returning()
        return elevated ?? { ...existing[0], isAdmin: true }
      }
      return existing[0]
    }

    const [created] = await tx.insert(users).values({
      id: `user_${phone}`,
      name: `Trader ${phone.slice(-4)}`,
      email: `${phone}@users.predik.local`,
      phoneNumber: phone,
      phoneNumberVerified: true,
      isAdmin: isConfiguredAdminPhone(phone),
    }).returning()
    return created
  })

  await ensureDemoCatalog()
  await ensureUserAccount(user.id, phone)
  return toSessionUser(user)
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('hex')
  await db.insert(sessions).values({
    token,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  })
  return token
}

export async function clearSession(token: string | undefined) {
  if (!token) return
  await db.delete(sessions).where(eq(sessions.token, token))
}

export async function getCurrentUser() {
  // The cookie store is only readable inside a request scope. If it is
  // unavailable there is no session to read, so this FAILS CLOSED
  // (unauthenticated) instead of throwing a 500 from every protected route.
  let token: string | undefined
  try {
    const cookieStore = await cookies()
    token = cookieStore.get(SESSION_COOKIE)?.value
  } catch (error) {
    console.warn('[auth] session cookie store unavailable; treating the request as unauthenticated', {
      reason: error instanceof Error ? error.message : 'unknown',
    })
    return null
  }
  if (!token) return null

  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, token)))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  if (row.session.expiresAt <= new Date()) {
    await clearSession(token)
    return null
  }
  return toSessionUser(row.user)
}

export async function getCurrentUserId() {
  const user = await getCurrentUser()
  if (!user) throw new Error('UNAUTHORIZED')
  return user.id
}

export function sessionCookieValue(token: string) {
  return { name: SESSION_COOKIE, value: token, options: cookieOptions() }
}
