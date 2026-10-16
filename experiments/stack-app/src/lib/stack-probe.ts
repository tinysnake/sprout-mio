import { Effect } from 'effect'
import { count, eq } from 'drizzle-orm'

import { db } from '#/db'
import { stackProbes } from '#/db/schema'

const insertProbe = (component: string) =>
  Effect.sync(() => {
    db.insert(stackProbes).values({ component }).run()
  })

const countProbes = (component: string) =>
  Effect.sync(
    () =>
      db
        .select({ total: count() })
        .from(stackProbes)
        .where(eq(stackProbes.component, component))
        .all()[0]?.total ?? 0,
  )

export const runStackProbe = (component: string) =>
  Effect.gen(function* () {
    yield* insertProbe(component)
    return yield* countProbes(component)
  })
