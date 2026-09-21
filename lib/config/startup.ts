/**
 * One secret-free configuration report, written to the deploy logs once per
 * server start.
 *
 * A deployment that is missing a required variable and fails silently is the
 * most expensive kind of outage to debug — especially from a phone. This module
 * exists so the first thing in the log is the answer: what environment this is,
 * which database it found, what the payment posture is, and which required
 * values are absent.
 *
 * Rules it must never break:
 *  - report *presence* and *names*, never values;
 *  - never print a connection string, a credential or a code;
 *  - stay short. One line per area, and a warning only when something is wrong.
 *
 * It reports on nothing and blocks nothing: a problem here is logged, and the
 * request path decides what to do about it (see `app/api/health`).
 */

type Verdict = 'ok' | 'warn' | 'error'

interface Line {
  area: string
  detail: string
  verdict: Verdict
}

const label = (area: string) => area.padEnd(10)

function countList(value: string | undefined): number {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean).length
}

function schemaBootstrapLine(): Line {
  const raw = (process.env.DATABASE_SCHEMA_BOOTSTRAP ?? 'auto').trim().toLowerCase()
  if (raw === 'auto') {
    return { area: 'schema', verdict: 'ok', detail: 'missing tables/triggers are created on first use (auto)' }
  }
  if (raw === 'off' || raw === 'disabled' || raw === 'false') {
    return { area: 'schema', verdict: 'ok', detail: 'bootstrap disabled — the schema must already exist' }
  }
  return {
    area: 'schema',
    verdict: 'warn',
    detail: `DATABASE_SCHEMA_BOOTSTRAP="${raw}" is not a recognised value; "auto" or "off" expected`,
  }
}

function databaseLine(problem: string | null, target: string | null, usePgVariables: boolean): Line {
  if (problem) {
    return { area: 'database', verdict: 'error', detail: `${problem} — every page that reads PostgreSQL will fail` }
  }
  const via = usePgVariables ? ' (from PG* variables)' : ''
  return { area: 'database', verdict: 'ok', detail: `configured target ${target}${via}` }
}

function authLines(nodeEnv: string): Line[] {
  const admins = countList(process.env.ADMIN_PHONES)
  const adminLine: Line =
    admins > 0
      ? { area: 'auth', verdict: 'ok', detail: `admin allowlist has ${admins} number(s)` }
      : nodeEnv === 'production'
        ? { area: 'auth', verdict: 'error', detail: 'ADMIN_PHONES is not set — this deployment has no admin account' }
        : { area: 'auth', verdict: 'warn', detail: 'ADMIN_PHONES is not set — no admin account exists' }

  const fixedCode = Boolean(process.env.OTP_FIXED_CODE?.trim())
  const demoOptIn = (process.env.ALLOW_DEMO_OTP ?? '').trim().toLowerCase() === 'true'

  let otpLine: Line
  if (fixedCode) {
    otpLine = { area: 'otp', verdict: 'ok', detail: 'sign-in codes come from OTP_FIXED_CODE' }
  } else if (demoOptIn) {
    otpLine = {
      area: 'otp',
      verdict: nodeEnv === 'production' ? 'warn' : 'ok',
      detail: 'ALLOW_DEMO_OTP=true — the built-in demo code is accepted',
    }
  } else if (nodeEnv === 'production') {
    otpLine = {
      area: 'otp',
      verdict: 'error',
      detail: 'OTP_FIXED_CODE is not set — sign-in will refuse with 503 rather than use the public demo code',
    }
  } else {
    otpLine = { area: 'otp', verdict: 'ok', detail: 'development demo code (no OTP_FIXED_CODE set)' }
  }

  return [adminLine, otpLine]
}

/**
 * Inspects the running configuration and writes the report. Never throws: a
 * configuration problem must be visible in the logs, not fatal to startup.
 */
export async function logStartupConfiguration(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const lines: Line[] = [
    { area: 'runtime', verdict: 'ok', detail: `${nodeEnv} · node ${process.version}` },
  ]

  try {
    const { databaseConfig } = await import('@/lib/db/config')
    lines.push(databaseLine(databaseConfig.problem, databaseConfig.target, databaseConfig.usePgEnvironmentVariables))
  } catch (error) {
    lines.push({
      area: 'database',
      verdict: 'error',
      detail: `could not resolve database configuration (${(error as Error).name})`,
    })
  }

  lines.push(schemaBootstrapLine())
  lines.push(...authLines(nodeEnv))

  const trustedOrigins = countList(process.env.TRUSTED_ORIGINS)
  lines.push({
    area: 'origins',
    verdict: 'ok',
    detail: trustedOrigins > 0
      ? `${trustedOrigins} extra trusted origin(s) for state-changing requests`
      : 'same-origin only (no TRUSTED_ORIGINS set)',
  })

  try {
    const { getPaymentConfig } = await import('@/lib/payments/config')
    const payments = getPaymentConfig()
    const degraded = payments.effective !== payments.requested
    lines.push({
      area: 'payments',
      verdict: degraded ? 'warn' : 'ok',
      detail:
        `${payments.effective} mode via ${payments.providerId}` +
        (degraded ? ` (requested ${payments.requested})` : '') +
        `; live money ${payments.liveEnabled ? 'ENABLED' : 'DISABLED'}` +
        `; balance-moving payments ${payments.mutationBlocked ? 'REFUSED' : 'allowed'}` +
        (payments.blockers.length > 0 ? `. Blockers: ${payments.blockers.join('; ')}` : ''),
    })
  } catch (error) {
    lines.push({
      area: 'payments',
      verdict: 'error',
      detail: `could not resolve payment configuration (${(error as Error).name})`,
    })
  }

  console.info('---- Predik configuration ----')
  for (const line of lines) {
    const text = `[config] ${label(line.area)} ${line.detail}`
    if (line.verdict === 'error') console.error(text)
    else if (line.verdict === 'warn') console.warn(text)
    else console.info(text)
  }
  const problems = lines.filter((line) => line.verdict === 'error').length
  console.info(
    problems === 0
      ? '---- configuration OK ----'
      : `---- ${problems} configuration problem(s) above — see docs/PRODUCTION-RUNBOOK.md ----`,
  )
}
