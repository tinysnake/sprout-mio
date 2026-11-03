import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await import("../../server/change-endpoint")).eventsResponse(request),
    },
  },
});
