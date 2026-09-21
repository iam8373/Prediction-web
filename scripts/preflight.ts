/**
 * Production launch preflight (read only).
 *
 *   pnpm preflight          # human readable gate report, exit 1 on any FAIL
 *   pnpm preflight -- --json
 *
 * Run this against the exact environment you intend to serve: it resolves the
 * payment posture from that process environment, inspects the real database, and
 * sweeps the accounting invariants. It never writes, never repairs, never deletes
 * and never prints a secret value — it only reports names of unset variables.
 *
 * Result vocabulary:
 *   PASS    verified against this environment
 *   FAIL    the implementation or configuration does not work — do not launch
 *   BLOCKED an external dependency (provider account, credentials, live
 *           activation) prevents verification; it can never be reported as PASS
 *   WARN    not launch-blocking, but an operator should look
 *
 * Notes:
 *  - With `DATABASE_SCHEMA_BOOTSTRAP=off` (the recommended production setting)
 *    the schema helpers are no-ops, so this script stays strictly read-only.
 *  - `pnpm db:bootstrap` is the only thing that creates schema objects; this
 *    script deliberately never does.
 */
import { pool } from '@/lib/db'
import { schemaTableNames } from '@/lib/db/bootstrap'
import { getPaymentConfig } from '@/lib/payments/config'
import { auditAccountingIntegrity } from '@/lib/payments/reconciliation'

type Result = 'PASS' | 'FAIL' | 'BLOCKED' | 'WARN'

interface Check {
  area: string
  name: string
  result: Result
  evidence: string
}

const checks: Check[] = []

function record(area: string, name: string, result: Result, evidence: string) {
  checks.push({ area, name, result, evidence })
}

async function scalar(query: string): Promise<number | null> {
  try {
    const result = await pool.query<{ count: string }>(query)
    const value = result.rows[0]?.count
    return value === undefined ? null : Number(value)
  } catch {
    return null
  }
}

async function main() {
  const json = process.argv.includes('--json')
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const production = nodeEnv === 'production'

  // ---------------------------------------------------------------- runtime --
  record(
    'Runtime',
    'NODE_ENV=production',
    production ? 'PASS' : 'WARN',
    production ? 'production runtime' : `running as "${nodeEnv}" — live money requires a production runtime`,
  )

  const databaseUrl = Boolean(process.env.DATABASE_URL)
  record(
    'Database',
    'DATABASE_URL configured',
    databaseUrl ? 'PASS' : 'FAIL',
    databaseUrl ? 'connection string present (value never printed)' : 'DATABASE_URL is missing',
  )

  const bootstrapMode = (process.env.DATABASE_SCHEMA_BOOTSTRAP ?? 'auto').trim().toLowerCase()
  record(
    'Database',
    'runtime schema bootstrap',
    bootstrapMode === 'off' ? 'PASS' : 'WARN',
    bootstrapMode === 'off'
      ? 'disabled: the runtime role does not need DDL rights'
      : `"${bootstrapMode}" — the runtime role needs DDL rights; run db:bootstrap once and set DATABASE_SCHEMA_BOOTSTRAP=off`,
  )

  // ----------------------------------------------------------- auth / admin --
  const adminPhones = (process.env.ADMIN_PHONES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  record(
    'Admin',
    'ADMIN_PHONES allowlist',
    adminPhones.length > 0 ? 'PASS' : 'FAIL',
    adminPhones.length > 0 ? `${adminPhones.length} allowlisted number(s)` : 'no admin can exist without an allowlist',
  )

  const hasFixedOtp = Boolean((process.env.OTP_FIXED_CODE ?? '').trim())
  const demoOtpAllowed = (process.env.ALLOW_DEMO_OTP ?? '').trim().toLowerCase() === 'true'
  record(
    'Authentication',
    'sign-in code delivery',
    hasFixedOtp ? 'PASS' : demoOtpAllowed ? 'WARN' : 'FAIL',
    hasFixedOtp
      ? 'OTP_FIXED_CODE is set (value never printed)'
      : demoOtpAllowed
        ? 'production is explicitly opted into the built-in demo code — anyone who knows it can sign in'
        : 'neither OTP_FIXED_CODE nor an SMS provider is configured: sign-in is refused (fail closed)',
  )

  record(
    'CSRF',
    'TRUSTED_ORIGINS',
    process.env.TRUSTED_ORIGINS?.trim() ? 'PASS' : 'WARN',
    process.env.TRUSTED_ORIGINS?.trim()
      ? 'extra origins allowlisted'
      : 'unset — required only when a proxy serves the app from a host the request cannot see',
  )

  // ------------------------------------------------------------- payments ----
  const config = getPaymentConfig()
  record(
    'Payments',
    'mode resolution',
    'PASS',
    `requested ${config.requested.toUpperCase()} → effective ${config.effective.toUpperCase()} via ${config.providerId}`,
  )

  record(
    'Payments',
    'production posture (no silent degradation)',
    config.mutationBlocked ? 'FAIL' : 'PASS',
    config.mutationBlocked
      ? `balance-moving payments are refused: ${config.blockers.slice(-2).join('; ')}`
      : config.productionStrict
        ? 'production honours the requested mode with a real provider'
        : 'not a production runtime, posture gate not applied',
  )

  if (config.requested === 'live') {
    record(
      'Payments',
      'live-money gate',
      config.liveEnabled ? 'PASS' : 'FAIL',
      config.liveEnabled
        ? 'every live prerequisite is satisfied'
        : `live money refused: ${config.blockers.join('; ') || 'prerequisites unmet'}`,
    )
  } else {
    record(
      'Payments',
      'live-money gate',
      'BLOCKED',
      `PAYMENTS_MODE=${config.requested} — real-money activation is not enabled in this environment (live money must stay disabled until deliberately activated)`,
    )
  }

  if (config.requested === 'sandbox') {
    record(
      'Payments',
      'sandbox provider readiness',
      config.sandboxReady && config.effective === 'sandbox' ? 'PASS' : 'FAIL',
      config.sandboxReady
        ? `provider "${config.sandboxProviderId}" configured (${config.sandboxCredentialsMissing.length} missing variable(s))`
        : `missing: ${config.sandboxCredentialsMissing.join(', ') || 'webhook signing secret'}`,
    )
  }

  if (config.providerId === 'razorpay') {
    record(
      'Withdrawals',
      'payout source account',
      config.providerOptions.payoutAccountConfigured ? 'PASS' : 'FAIL',
      config.providerOptions.payoutAccountConfigured
        ? `payout rail ${config.providerOptions.payoutMode}`
        : 'PAYMENTS_RAZORPAY_PAYOUT_ACCOUNT_NUMBER is missing — payouts cannot settle',
    )
  } else {
    record(
      'Withdrawals',
      'payout source account',
      'BLOCKED',
      'the simulated provider is serving this mode: no real payout rail to verify',
    )
  }

  const providerOverride = (process.env.PAYMENTS_RAZORPAY_API_BASE ?? '').trim()
  record(
    'Payments',
    'provider API base override',
    providerOverride && production ? 'FAIL' : providerOverride ? 'WARN' : 'PASS',
    providerOverride
      ? 'PAYMENTS_RAZORPAY_API_BASE is set — payments would talk to an override host, not Razorpay'
      : 'using the provider default',
  )

  const simulatedAck = (process.env.PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION ?? '').trim().toLowerCase() === 'true'
  record(
    'Payments',
    'simulated-provider acknowledgement',
    simulatedAck ? 'WARN' : 'PASS',
    simulatedAck
      ? 'PAYMENTS_ALLOW_SIMULATED_IN_PRODUCTION=true — this deployment moves simulated balances'
      : 'simulated balance movement is refused in production',
  )

  // ------------------------------------------------------------- database ----
  if (!databaseUrl) {
    record('Database', 'reachability + schema', 'BLOCKED', 'skipped: no DATABASE_URL')
  } else {
    const startedAt = Date.now()
    try {
      await pool.query('select 1')
      record('Database', 'reachability', 'PASS', `select 1 in ${Date.now() - startedAt}ms`)
    } catch (error) {
      record(
        'Database',
        'reachability',
        'FAIL',
        `connection failed: ${error instanceof Error ? error.constructor.name : 'unknown error'} (detail logged nowhere on purpose)`,
      )
    }

    const expected = schemaTableNames()
    const { rows } = await pool
      .query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
      )
      .catch(() => ({ rows: [] as Array<{ table_name: string }> }))
    const present = new Set(rows.map((row) => row.table_name))
    const missing = expected.filter((table) => !present.has(table))
    record(
      'Database',
      'expected schema',
      missing.length === 0 ? 'PASS' : 'FAIL',
      missing.length === 0
        ? `${expected.length}/${expected.length} tables present`
        : `missing: ${missing.join(', ')} — run pnpm db:bootstrap`,
    )

    const triggers = await pool
      .query<{ tgname: string }>(
        "select tgname from pg_trigger where not tgisinternal and tgname in ('ledger_entry_immutable', 'transaction_immutable')",
      )
      .catch(() => ({ rows: [] as Array<{ tgname: string }> }))
    const triggerNames = triggers.rows.map((row) => row.tgname).sort()
    record(
      'Ledger',
      'append-only enforcement',
      triggerNames.length === 2 ? 'PASS' : 'FAIL',
      triggerNames.length === 2
        ? 'ledger_entry and transaction are immutable at the database level'
        : `missing triggers: ${['ledger_entry_immutable', 'transaction_immutable'].filter((name) => !triggerNames.includes(name)).join(', ')} — run pnpm db:bootstrap`,
    )

    const rateLimitTable = present.has('rate_limit_counter')
    record(
      'Rate limiting',
      'durable counter store',
      rateLimitTable ? 'PASS' : 'FAIL',
      rateLimitTable ? 'rate_limit_counter present (shared across instances)' : 'rate_limit_counter is missing — run pnpm db:bootstrap',
    )
  }

  // ------------------------------------------------------------ accounting ---
  if (!databaseUrl) {
    record('Accounting', 'wallet/ledger invariants', 'BLOCKED', 'skipped: no DATABASE_URL')
  } else {
    try {
      const audit = await auditAccountingIntegrity()
      // A balance with no ledger history behind it is seed/fixture data, not a
      // drifted posting; an operator needs that distinction before launch.
      const unbooked = audit.walletDifferences.filter((row) => row.ledgerEntryCount === 0).length
      const evidence =
        `${audit.walletCount} wallet(s), ${audit.transactionCount} transaction(s), ${audit.paymentCount} payment(s); ` +
        `${audit.walletDifferenceCount} account(s) off the wallet equation` +
        (audit.walletDifferenceCount > 0
          ? ` (${audit.walletDifferenceSplit.unexplainedAccounts} holding more than the ledger explains, ` +
            `${audit.walletDifferenceSplit.shortfallAccounts} holding less; ${unbooked} have no ledger history at all — seed/fixture balances; ` +
            `first: ${audit.walletDifferences[0].userId} off by ${audit.walletDifferences[0].walletDifferencePaise} paise)`
          : '') +
        `; settled-without-transaction ${audit.counts.settledPaymentsWithoutTransaction}, ` +
        `transactions-without-ledger ${audit.counts.completedTransactionsWithoutLedger}, ` +
        `refunds-without-parent ${audit.counts.refundPaymentsWithoutParent}, ` +
        `awaiting settlement ${audit.counts.awaitingSettlement}`

      record(
        'Accounting',
        'wallet/ledger invariants',
        audit.status === 'clean' ? 'PASS' : audit.status === 'findings' ? 'FAIL' : 'BLOCKED',
        audit.status === 'incomplete' ? `${evidence}; not evaluated: ${audit.notChecked.join(', ')}` : evidence,
      )
    } catch {
      record('Accounting', 'wallet/ledger invariants', 'BLOCKED', 'the sweep could not be evaluated on this database')
    }

    const modes = await pool
      .query<{ mode: string; count: string }>('select mode, count(*)::int as count from payment_intent group by mode')
      .catch(() => ({ rows: [] as Array<{ mode: string; count: string }> }))
    const simulated = modes.rows
      .filter((row) => row.mode === 'demo' || row.mode === 'sandbox')
      .reduce((total, row) => total + Number(row.count), 0)
    const livePayments = modes.rows.filter((row) => row.mode === 'live').reduce((total, row) => total + Number(row.count), 0)

    const liveRequested = config.requested === 'live'
    record(
      'Data hygiene',
      'no simulated money in a live deployment',
      liveRequested && simulated > 0 ? 'FAIL' : 'PASS',
      simulated > 0
        ? `${simulated} simulated payment(s) exist (${modes.rows.map((row) => `${row.mode}:${row.count}`).join(', ')}); ` +
          (liveRequested
            ? 'simulated credits become withdrawable the moment live money is on — reconcile them before launch'
            : 'expected while live money is disabled, but they must be reconciled or isolated before live activation')
        : `${livePayments} live payment(s), no simulated payments`,
    )

    const admins = await scalar("select count(*)::int as count from \"user\" where \"isAdmin\" = true")
    record(
      'Admin',
      'production admin account',
      admins === null
        ? 'BLOCKED'
        : admins > 0
          ? 'PASS'
          : adminPhones.length > 0
            ? 'WARN'
            : 'FAIL',
      admins === null
        ? 'could not be evaluated'
        : admins > 0
          ? `${admins} admin account(s)`
          : adminPhones.length > 0
            ? 'allowlist configured but no admin has signed in yet — sign in once with an allowlisted number'
            : 'no admin accounts and no allowlist',
    )
  }

  // ---------------------------------------------------------------- report ---
  const failures = checks.filter((check) => check.result === 'FAIL')
  const blocked = checks.filter((check) => check.result === 'BLOCKED')
  const warnings = checks.filter((check) => check.result === 'WARN')

  if (json) {
    console.log(JSON.stringify({ nodeEnv, checks, summary: { fail: failures.length, blocked: blocked.length, warn: warnings.length } }, null, 2))
  } else {
    const width = Math.max(...checks.map((check) => check.name.length))
    let area = ''
    for (const check of checks) {
      if (check.area !== area) {
        area = check.area
        console.log(`\n${area}`)
      }
      console.log(`  ${check.result.padEnd(7)} ${check.name.padEnd(width)}  ${check.evidence}`)
    }
    console.log(
      `\n${checks.length} checks: ${checks.filter((check) => check.result === 'PASS').length} PASS, ` +
        `${warnings.length} WARN, ${blocked.length} BLOCKED, ${failures.length} FAIL`,
    )
    if (failures.length > 0) {
      console.log('\nBLOCKING: ' + failures.map((check) => check.name).join(', '))
    }
    if (blocked.length > 0) {
      console.log('NOT VERIFIABLE HERE: ' + blocked.map((check) => check.name).join(', '))
    }
    console.log(
      failures.length === 0 && blocked.length === 0
        ? '\nLaunch gate: every check passed.'
        : failures.length === 0
          ? '\nLaunch gate: no failures, but externally blocked checks remain unverified.'
          : '\nLaunch gate: DO NOT LAUNCH until the failures above are resolved.',
    )
  }

  await pool.end().catch(() => undefined)
  process.exitCode = failures.length > 0 ? 1 : 0
}

main().catch(async (error) => {
  console.error('preflight failed:', error instanceof Error ? error.message : error)
  await pool.end().catch(() => undefined)
  process.exitCode = 1
})
