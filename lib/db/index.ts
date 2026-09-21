import 'server-only'

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { databaseConfig } from './config'
import * as schema from './schema'

/**
 * One connection pool per server process.
 *
 * `connectionTimeoutMillis` bounds how long a query waits for a connection, so
 * an unreachable database produces a prompt, debuggable error instead of a
 * request that hangs until the platform kills it.
 *
 * The `error` listener is not optional: an unhandled `error` event on an *idle*
 * client terminates the Node process. A managed database recycling idle
 * connections would otherwise restart the whole deployment, which looks like
 * random 500s rather than a connection-pool problem.
 */
export const pool = new Pool({
  connectionString: databaseConfig.connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

pool.on('error', (error) => {
  console.error('[db] idle client error:', error.message)
})

export const db = drizzle(pool, { schema })

/** A Drizzle transaction handle. Services accept this so they can run inside a caller's transaction. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Either the pooled client or an open transaction. */
export type DbClient = typeof db | DbTransaction
