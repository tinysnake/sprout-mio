import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { SubmitEvent } from "react";
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

function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const result = await authenticate({
        data: {
          action: mode,
          email: form.get("email"),
          password: form.get("password"),
          ...(mode === "register" ? { name: form.get("name") } : {}),
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

  const inputClass = "mt-2 w-full rounded-md border border-input bg-background px-3 py-2";
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-sm text-muted-foreground">Sprout Mio</p>
      <h1 className="mt-3 text-3xl font-semibold">{mode === "login" ? "登录" : "注册 Human"}</h1>
      <p className="mt-3 text-muted-foreground">
        {mode === "login" ? "使用邮箱和密码进入工作区。" : "创建你的登录账号。"}
      </p>
      <form onSubmit={submit} className="mt-8 space-y-5" aria-busy={pending}>
        {mode === "register" && (
          <label className="block">
            姓名
            <input name="name" autoComplete="name" required maxLength={80} className={inputClass} />
          </label>
        )}
        <label className="block">
          邮箱
          <input type="email" name="email" autoComplete="email" required className={inputClass} />
        </label>
        <label className="block">
          密码
          <input
            type="password"
            name="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
            maxLength={128}
            className={inputClass}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}（{error.code}，{error.requestId}）
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
        >
          {pending ? "正在提交…" : mode === "login" ? "登录" : "注册"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
          className="w-full text-sm underline disabled:opacity-50"
        >
          {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
        </button>
      </form>
    </main>
  );
}
