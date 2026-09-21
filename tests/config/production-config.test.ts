import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { describeTarget, resolveDatabaseConfig } from '@/lib/db/config'

/**
 * These lock in the behaviour that turns "the site is a blank 500" into a clear
 * deploy-log message. The rule under test throughout: a missing or malformed
 * database target must never be silently replaced by the local default.
 */
describe('Database configuration resolution', () => {
  test('accepts a postgres:// URL and strips the credentials from the target', () => {
    const config = resolveDatabaseConfig({ DATABASE_URL: 'postgres://app:s3cret@db.internal:5432/predik' })
    assert.equal(config.configured, true)
    assert.equal(config.problem, null)
    assert.equal(config.usePgEnvironmentVariables, false)
    assert.equal(config.target, 'db.internal:5432/predik')
    assert.ok(!(config.target ?? '').includes('s3cret'), 'the logged target must never contain a password')
  })

  test('credentials that break a URL parser do not mis-parse the host', () => {
    // '@' and ':' are both legal inside a password; the host begins after the
    // LAST '@' in the authority section, not the first.
    const target = describeTarget('postgresql://app:p@ss:word@db.internal:6543/predik?sslmode=require')
    assert.equal(target, 'db.internal:6543/predik')
  })

  test('defaults the port and reports an unnamed database', () => {
    assert.equal(describeTarget('postgres://db.internal/predik'), 'db.internal:5432/predik')
    assert.equal(describeTarget('postgres://db.internal'), 'db.internal:5432/(default)')
  })

  test('an unset DATABASE_URL is reported as missing, never defaulted to localhost', () => {
    const config = resolveDatabaseConfig({})
    assert.equal(config.configured, false)
    assert.equal(config.connectionString, undefined)
    assert.match(config.problem ?? '', /DATABASE_URL is not set/)
    assert.equal(config.target, null)
  })

  test('a non-PostgreSQL URL fails closed but is still handed to pg', () => {
    const config = resolveDatabaseConfig({ DATABASE_URL: 'mysql://app:secret@db.internal:3306/predik' })
    assert.equal(config.configured, false)
    assert.match(config.problem ?? '', /postgres:\/\//)
    // Passing the value through is deliberate: pg then fails loudly rather than
    // quietly connecting to the local default.
    assert.equal(config.connectionString, 'mysql://app:secret@db.internal:3306/predik')
    assert.equal(config.target, null)
  })

  test('a URL with no host does not count as configured', () => {
    assert.equal(resolveDatabaseConfig({ DATABASE_URL: 'postgres://' }).configured, false)
  })

  test('an incomplete PG* environment does not count as configured', () => {
    const config = resolveDatabaseConfig({ PGHOST: 'db.internal' })
    assert.equal(config.configured, false)
    assert.equal(config.usePgEnvironmentVariables, false)
  })

  test('a complete PG* environment is accepted and marked as such', () => {
    const config = resolveDatabaseConfig({ PGHOST: 'db.internal', PGDATABASE: 'predik' })
    assert.equal(config.configured, true)
    assert.equal(config.usePgEnvironmentVariables, true)
    assert.equal(config.connectionString, undefined)
    assert.equal(config.target, 'db.internal:5432/predik')
  })
})

describe('Health probes', () => {
  test('liveness answers 200 without depending on the database', async () => {
    const { GET } = await import('@/app/api/health/live/route')
    const response = await GET()

    // A platform healthcheck must not fail a deploy because a dependency is
    // still being provisioned — that is the readiness probe's job.
    assert.equal(response.status, 200)

    const body = (await response.json()) as Record<string, unknown>
    assert.equal(body.ok, true)
    assert.equal(body.probe, 'liveness')

    const serialized = JSON.stringify(body)
    for (const forbidden of ['database', 'DATABASE_URL', 'postgres://', 'secret']) {
      assert.ok(!serialized.includes(forbidden), `liveness probe leaked "${forbidden}"`)
    }
  })
})
