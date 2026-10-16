import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Index,
})

function Index() {
  return (
    <main>
      <h1>sprout P0 runtime host experiment</h1>
      <ul>
        <li>
          <code>GET /api/counter</code> bumps and returns the resident runtime state
        </li>
        <li>
          <code>GET /api/events?durationMs=30000</code> SSE stream of background ticks
        </li>
        <li>
          <code>GET /api/diagnostics</code> cross-module-evaluation counters
        </li>
      </ul>
    </main>
  )
}
