import { eq, sql } from 'drizzle-orm'

import { db } from '#/db'
import { probeItems } from '#/db/schema'

export type SqliteErrorInfo = { code: string | null; message: string }

export type DbCheck = {
  name: string
  passed: boolean
  detail: Record<string, unknown>
}

const UNIQUE_SLUG = 'probe-unique'
const CONTROL_ID = 'probe-control'
const ROLLBACK_ID = 'probe-tx-rollback'

function errorInfo(error: unknown): SqliteErrorInfo {
  const candidate = error as { code?: string; message?: string; cause?: unknown }
  const cause = candidate?.cause as { code?: string; message?: string } | undefined
  return {
    code: candidate?.code ?? cause?.code ?? null,
    message: candidate?.message ?? String(error),
  }
}

function rowsWithId(id: string) {
  return db.select().from(probeItems).where(eq(probeItems.id, id)).all()
}

function rowsWithSlug(slug: string) {
  return db.select().from(probeItems).where(eq(probeItems.slug, slug)).all()
}

type Executor = { run: (query: ReturnType<typeof sql>) => unknown }

function insertDuplicatePrimaryKey(executor: Executor, id: string) {
  executor.run(
    sql`insert into probe_items (id, slug, label) values (${id}, ${`${id}-dup`}, 'dup-pk')`,
  )
}

export function runDbChecks(): DbCheck[] {
  db.delete(probeItems).run()

  db.insert(probeItems).values({ id: 'probe-unique-1', slug: UNIQUE_SLUG, label: 'first' }).run()
  let uniqueError: SqliteErrorInfo | null = null
  try {
    db.insert(probeItems)
      .values({ id: 'probe-unique-2', slug: UNIQUE_SLUG, label: 'second' })
      .run()
  } catch (error) {
    uniqueError = errorInfo(error)
  }
  const afterUnique = rowsWithSlug(UNIQUE_SLUG)

  db.insert(probeItems)
    .values({ id: CONTROL_ID, slug: CONTROL_ID, label: 'control' })
    .run()
  let controlError: SqliteErrorInfo | null = null
  try {
    insertDuplicatePrimaryKey(db, CONTROL_ID)
  } catch (error) {
    // Same failure the transacted run hits; only whether the first row survives matters.
    controlError = errorInfo(error)
  }
  const afterControl = rowsWithId(CONTROL_ID)

  let rollbackError: SqliteErrorInfo | null = null
  try {
    db.transaction((tx) => {
      tx.insert(probeItems)
        .values({ id: ROLLBACK_ID, slug: ROLLBACK_ID, label: 'inside-transaction' })
        .run()
      insertDuplicatePrimaryKey(tx, ROLLBACK_ID)
    })
  } catch (error) {
    rollbackError = errorInfo(error)
  }
  const afterRollback = rowsWithId(ROLLBACK_ID)

  return [
    {
      name: 'unique_conflict',
      passed:
        uniqueError?.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        afterUnique.length === 1 &&
        afterUnique[0]!.label === 'first',
      detail: {
        error: uniqueError,
        rowsAfterConflict: afterUnique.map((row) => row.id),
      },
    },
    {
      name: 'insert_without_transaction_persists',
      passed: controlError !== null && afterControl.length === 1,
      detail: {
        error: controlError,
        rowsAfterFailedInsert: afterControl.map((row) => row.id),
      },
    },
    {
      name: 'transaction_rollback',
      passed: rollbackError !== null && afterRollback.length === 0,
      detail: {
        error: rollbackError,
        rowsAfterRollback: afterRollback.map((row) => row.id),
        positiveControl: 'insert_without_transaction_persists',
      },
    },
  ]
}
