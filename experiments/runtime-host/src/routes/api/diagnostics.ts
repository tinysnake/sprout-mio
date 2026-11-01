import { createFileRoute } from '@tanstack/react-router'
import { hostDiagnostics, hostReady } from '../../server/runtime'

export const Route = createFileRoute('/api/diagnostics')({
  server: {
    handlers: {
      GET: async () => {
        await hostReady
        return Response.json(hostDiagnostics())
      },
    },
  },
})
