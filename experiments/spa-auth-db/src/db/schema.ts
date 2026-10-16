import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const probeItems = sqliteTable('probe_items', {
  id: text().primaryKey(),
  slug: text().notNull().unique(),
  label: text().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(
    sql`(unixepoch())`,
  ),
})

export * from './auth-schema.ts'
