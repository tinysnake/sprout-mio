import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  validateSearch: (search: Record<string, unknown>): { tab?: "general" | "webhooks" | "cron" } => ({
    tab: search.tab === "webhooks" || search.tab === "cron" ? search.tab : "general",
  }),
  component: Outlet,
});
