import { createFileRoute, Link } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

export const Route = createFileRoute('/second')({ component: SecondPage })

function SecondPage() {
  return (
    <div className="p-8 space-y-6">
      <h1 className="text-4xl font-bold">Second page</h1>
      <p className="mt-4 text-lg" data-testid="second-marker">
        deep-link-target
      </p>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">shadcn + Base UI</h2>
        <Button data-testid="styled-button" variant="default">
          Base UI button
        </Button>

        <Dialog>
          <DialogTrigger
            data-testid="dialog-trigger"
            render={<Button variant="outline">Open dialog</Button>}
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Base UI dialog</DialogTitle>
              <DialogDescription data-testid="dialog-marker">
                dialog-rendered
              </DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      </section>

      <Link to="/" className="inline-block underline">
        Back to home
      </Link>
    </div>
  )
}
