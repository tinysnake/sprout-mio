import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/webhooks/$ruleId")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        (await import("../server/webhook-ingress")).webhookPost(request, params.ruleId),
    },
  },
});
