import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export * from './auth-schema.ts'

export const stackProbes = sqliteTable('stack_probes', {
  id: integer({ mode: 'number' }).primaryKey({ autoIncrement: true }),
  component: text().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})
