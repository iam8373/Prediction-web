import 'server-only'

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

export const db = drizzle(pool, { schema })

/** A Drizzle transaction handle. Services accept this so they can run inside a caller's transaction. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Either the pooled client or an open transaction. */
export type DbClient = typeof db | DbTransaction
