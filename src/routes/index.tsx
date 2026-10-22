import { createFileRoute, redirect } from "@tanstack/react-router";
import { getProtectedSession } from "../server/session";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (import.meta.env.SSR) return;
    const result = await getProtectedSession();
    if (!result.ok) {
      if (result.error.code === "unauthorized") throw redirect({ to: "/login" });
      throw new Error(result.error.message);
    }
    throw redirect({ to: "/projects" });
  },
});
