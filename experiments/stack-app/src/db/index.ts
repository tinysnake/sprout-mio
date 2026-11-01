import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema.ts'

export const databaseUrl = process.env.DATABASE_URL ?? 'dev.db'

export const db = drizzle(databaseUrl, { schema })
