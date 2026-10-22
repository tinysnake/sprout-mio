import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { LoginView } from "../components/auth/login-view";
import type { LoginMode, LoginValues } from "../components/auth/login-view";
import type { AppError } from "../contracts/result";
import { toAppError } from "../contracts/result";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { authenticate, getSessionInfo } from "../server/session";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (import.meta.env.SSR) return;
    const result = await getSessionInfo();
    if (result.ok && result.data) throw redirect({ to: "/" });
  },
  component: Login,
});

/** 认证边界在 server function：这里只把结果映射成 pending 与可追踪错误。 */
function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>("login");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function submit(values: LoginValues) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await authenticate({
        data: {
          action: mode,
          email: values.email,
          password: values.password,
          ...(mode === "register" ? { name: values.name } : {}),
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await router.invalidate();
      await router.navigate({ to: "/" });
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <LoginView
      mode={mode}
      onModeChange={(next) => {
        setMode(next);
        setError(null);
      }}
      pending={pending}
      error={error}
      onSubmit={(values) => void submit(values)}
    />
  );
}
