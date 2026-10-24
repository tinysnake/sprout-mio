import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/remote/agent")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await import("../../../server/remote-agent-gateway")).remoteAgentResponse(request),
    },
  },
});
