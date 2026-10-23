import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/worker/close")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await import("../../../server/worker-gateway")).workerResponse("close", request),
    },
  },
});
