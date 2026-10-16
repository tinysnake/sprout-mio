import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'

import { runStackProbe } from '#/lib/stack-probe'

const health = Effect.gen(function* () {
  const probes = yield* runStackProbe('health')
  return { ok: true, probes }
})

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const body = await Effect.runPromise(health)
        return Response.json(body)
      },
    },
  },
})
