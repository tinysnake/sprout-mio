import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/worker/open")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await import("../../../server/worker-gateway")).workerResponse("open", request),
    },
  },
});
