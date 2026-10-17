import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { APP_VERSION } from "../contracts/version";
import type { AppError } from "../contracts/result";
import { toAppError } from "../contracts/result";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { authenticate, getProtectedSession } from "../server/session";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (import.meta.env.SSR) return { human: null };
    const result = await getProtectedSession();
    if (!result.ok) {
      if (result.error.code === "unauthorized") throw redirect({ to: "/login" });
      throw new Error(result.error.message);
    }
    return { human: result.data };
  },
  component: Home,
});

function Home() {
  const { human } = Route.useRouteContext();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    try {
      const result = await authenticate({ data: { action: "logout" } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await router.invalidate();
      await router.navigate({ to: "/login" });
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  if (!human) return null;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-sm text-muted-foreground">版本 {APP_VERSION}</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">Sprout Mio</h1>
      <p className="mt-6 text-base text-muted-foreground">
        已登录，{human.name}（{human.email}）。
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error.message}（{error.code}，{error.requestId}）
        </p>
      )}
      <Link to="/projects" data-testid="open-projects" className="mt-6 self-start underline">
        进入 Project
      </Link>
      <button
        type="button"
        disabled={pending}
        onClick={signOut}
        className="mt-6 self-start rounded-md border border-input px-4 py-2 disabled:opacity-50"
      >
        {pending ? "正在登出…" : "登出"}
      </button>
    </main>
  );
}
