import { createFileRoute } from '@tanstack/react-router'
import {
  hostDiagnostics,
  hostReady,
  hostRuntime,
  type HostSnapshot,
} from '../../server/runtime'

export const Route = createFileRoute('/api/events')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await hostReady
        const url = new URL(request.url)
        const durationMs = Number(url.searchParams.get('durationMs') ?? 0)
        const encoder = new TextEncoder()
        let unsubscribe = () => {}
        let timer: ReturnType<typeof setTimeout> | undefined

        const cleanup = () => {
          unsubscribe()
          if (timer) clearTimeout(timer)
        }

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: string, data: unknown) => {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              )
            }
            const frame = (snapshot: HostSnapshot) => ({
              ...snapshot,
              diagnostics: hostDiagnostics(),
            })
            send('hello', frame(hostRuntime.snapshot()))
            unsubscribe = hostRuntime.subscribe((snapshot) => {
              try {
                send('tick', frame(snapshot))
              } catch {
                cleanup()
              }
            })
            if (durationMs > 0) {
              timer = setTimeout(() => {
                cleanup()
                try {
                  controller.close()
                } catch {
                  // already closed by the client
                }
              }, durationMs)
            }
          },
          cancel() {
            console.log(
              `[runtime-host] sse client disconnected; per-connection cleanup only instance=${hostRuntime.instanceId}`,
            )
            cleanup()
          },
        })

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          },
        })
      },
    },
  },
})
