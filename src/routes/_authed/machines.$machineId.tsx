import { createFileRoute, Outlet } from "@tanstack/react-router";
import { z } from "zod";

export const Route = createFileRoute("/_authed/machines/$machineId")({
  validateSearch: z.object({ projectId: z.string().optional() }),
  component: Outlet,
});
