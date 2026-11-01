import { createFileRoute } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <div className="p-8">
      <h1 className="text-4xl font-bold">P0 stack experiment</h1>
      <p className="mt-4 text-lg">
        TanStack Start + Vite+ + Drizzle + Better Auth + shadcn/Base UI + Effect
      </p>
      <div className="mt-6 flex gap-3">
        <Button
          render={<a href="/api/health" />}
          nativeButton={false}
        >
          Check /api/health
        </Button>
      </div>
    </div>
  )
}
