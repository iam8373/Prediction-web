import 'server-only'

/**
 * Database configuration, resolved once per process and described in words.
 *
 * Why this module exists: `pg` treats a *missing* `DATABASE_URL` as "use the
 * local default" and dials `localhost:5432` inside the container. On a host with
 * no local server that refusal takes about two milliseconds, so every page that
 * reads PostgreSQL fails instantly, the deploy logs contain no clue, and the
 * real cause — one unset environment variable — is invisible from outside.
 *
 * So: either the operator configured a target and `configured` is true, or
 * `configured` is false and `problem` says exactly what is missing. Nothing here
 * ever returns or logs a credential.
 */

/**
 * The shape this module needs: a bag of string-valued variables. Deliberately
 * not `NodeJS.ProcessEnv`, which Next.js augments with a required `NODE_ENV`,
 * so that a caller can pass a partial environment.
 */
export type Environment = Readonly<Record<string, string | undefined>>

export interface DatabaseConfig {
  /**
   * Handed straight to `pg`. Set whenever `DATABASE_URL` exists — even if it
   * looks wrong — because giving `pg` *any* string stops it silently dialling
   * the local default. A malformed value then fails loudly instead of quietly
   * connecting to the wrong place.
   */
  connectionString: string | undefined
  /** True when a usable target was explicitly configured. */
  configured: boolean
  /** The target came from PG* variables rather than DATABASE_URL. */
  usePgEnvironmentVariables: boolean
  /** Operator-facing explanation of what is wrong. Never contains a credential. */
  problem: string | null
  /** `host:port/database` summary with credentials stripped. Safe to log. */
  target: string | null
}

function trim(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

/** Splits `host:port`, keeping an IPv6 literal's own colons inside its brackets. */
function splitHostPort(hostPort: string): { host: string; port: string } {
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']')
    if (close === -1) return { host: '', port: '5432' }
    const port = hostPort.slice(close + 1).replace(/^:/, '')
    return { host: hostPort.slice(0, close + 1), port: port || '5432' }
  }
  const colon = hostPort.lastIndexOf(':')
  if (colon === -1) return { host: hostPort, port: '5432' }
  const port = hostPort.slice(colon + 1)
  return /^\d+$/.test(port)
    ? { host: hostPort.slice(0, colon), port }
    : { host: hostPort, port: '5432' }
}

/**
 * `host:port/database` for an operator log — never the credentials, never the
 * query string. Returns null when the string is not a usable PostgreSQL URL,
 * which is what turns a wrong `DATABASE_URL` into a clear message instead of a
 * silent connection to the local default.
 *
 * Written as explicit slicing rather than one clever regular expression because
 * credentials may legally contain both '@' and ':' — the host therefore starts
 * after the *last* '@' in the authority section, not the first.
 */
export function describeTarget(connectionString: string): string | null {
  const scheme = /^postgres(?:ql)?:\/\//i.exec(connectionString)
  if (!scheme) return null

  const rest = connectionString.slice(scheme[0].length)
  const authorityEnd = rest.search(/[/?#]/)
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd)
  const afterAuthority = authorityEnd === -1 ? '' : rest.slice(authorityEnd)

  const { host, port } = splitHostPort(authority.slice(authority.lastIndexOf('@') + 1))
  if (!host) return null

  const database = afterAuthority.startsWith('/')
    ? afterAuthority.slice(1).split(/[?#]/, 1)[0]
    : ''

  return `${host}:${port}/${database || '(default)'}`
}

/** The target `pg` would discover from PG* variables alone, if they are complete. */
function pgEnvironmentTarget(env: Environment): string | null {
  const host = trim(env.PGHOST)
  const database = trim(env.PGDATABASE)
  if (!host || !database) return null
  return `${host}:${trim(env.PGPORT) ?? '5432'}/${database}`
}

/**
 * Resolves the configuration from an environment. Exported with an explicit
 * parameter — rather than reading `process.env` directly — so the rules above
 * can be tested without mutating the real environment.
 */
export function resolveDatabaseConfig(env: Environment = process.env): DatabaseConfig {
  const url = trim(env.DATABASE_URL)

  if (url) {
    const target = describeTarget(url)
    return {
      connectionString: url,
      configured: target !== null,
      usePgEnvironmentVariables: false,
      problem: target === null ? 'DATABASE_URL is not a postgres:// or postgresql:// URL' : null,
      target,
    }
  }

  const fromPgVariables = pgEnvironmentTarget(env)
  if (fromPgVariables) {
    return {
      connectionString: undefined,
      configured: true,
      usePgEnvironmentVariables: true,
      problem: null,
      target: fromPgVariables,
    }
  }

  return {
    connectionString: undefined,
    configured: false,
    usePgEnvironmentVariables: false,
    problem: 'DATABASE_URL is not set (and no complete PGHOST/PGDATABASE pair is present)',
    target: null,
  }
}

/** Resolved once — the process environment cannot change while the server runs. */
export const databaseConfig: DatabaseConfig = resolveDatabaseConfig()

export function isDatabaseConfigured(): boolean {
  return databaseConfig.configured
}

/** Fails with a clear, credential-free message wherever a missing database must stop work. */
export function assertDatabaseConfigured(): void {
  if (!databaseConfig.configured) {
    throw new Error(`Database is not configured: ${databaseConfig.problem}`)
  }
}
