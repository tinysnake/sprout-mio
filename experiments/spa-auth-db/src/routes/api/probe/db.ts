import { createFileRoute } from '@tanstack/react-router'

import { runDbChecks } from '#/server/db-checks'

export const Route = createFileRoute('/api/probe/db')({
  server: {
    handlers: {
      POST: async () => Response.json({ checks: runDbChecks() }),
    },
  },
})
