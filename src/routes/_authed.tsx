import { Link, Outlet, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { authenticate, getProtectedSession } from "../server/session";

/** 受保护区域的统一入口，未登录的请求在渲染页面前落到 `/login`。 */
export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    if (import.meta.env.SSR) return { human: null };
    const result = await getProtectedSession();
    if (!result.ok) {
      if (result.error.code === "unauthorized") throw redirect({ to: "/login" });
      throw new Error(result.error.message);
    }
    return { human: result.data };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { human } = Route.useRouteContext();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    try {
      const result = await authenticate({ data: { action: "logout" } });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await router.invalidate();
      await router.navigate({ to: "/login" });
    } finally {
      setPending(false);
    }
  }

  if (!human) return null;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border/60">
        <nav className="mx-auto flex max-w-3xl items-center gap-4 px-6 py-4 text-sm">
          <Link to="/projects" className="font-medium" activeProps={{ className: "underline" }}>
            Project
          </Link>
          <Link
            to="/agents"
            data-testid="nav-agents"
            className="font-medium"
            activeProps={{ className: "underline" }}
          >
            Agents
          </Link>
          <span data-testid="session-email" className="ml-auto text-muted-foreground">
            {human.email}
          </span>
          <button
            type="button"
            data-testid="sign-out"
            disabled={pending}
            onClick={signOut}
            className="rounded-md border border-input px-3 py-1.5 disabled:opacity-50"
          >
            {pending ? "正在登出…" : "登出"}
          </button>
        </nav>
        {error && (
          <p role="alert" className="mx-auto max-w-3xl px-6 pb-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
