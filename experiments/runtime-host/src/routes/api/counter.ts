import { createFileRoute } from '@tanstack/react-router'
import {
  hostDiagnostics,
  hostReady,
  hostRuntime,
} from '../../server/runtime'

export const Route = createFileRoute('/api/counter')({
  server: {
    handlers: {
      GET: async () => {
        await hostReady
        hostRuntime.bump()
        return Response.json({
          snapshot: hostRuntime.snapshot(),
          diagnostics: hostDiagnostics(),
        })
      },
    },
  },
})
