import { Lock, Sprout } from "lucide-react";
import type { FormEvent } from "react";
import type { AppError } from "../../contracts/result";
import { ThemeToggle } from "../layout/theme-toggle";
import { ResultError } from "../project/result-error";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";

export type LoginMode = "login" | "register";

/** 表单提交的原始值；认证由调用方完成，呈现组件不接触 session 或 server function。 */
export type LoginValues = { name: string; email: string; password: string };

function values(form: FormData): LoginValues {
  const read = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  return { name: read("name"), email: read("email"), password: read("password") };
}

const tabClass =
  "min-h-8.5 flex-1 border-b-2 pb-2.5 pt-1 text-xs font-medium transition-colors max-desktop:min-h-11";

/**
 * 登录与注册共用的表单呈现。没有全局 header：品牌与主题切换并入表单顶部，
 * 与工作台外壳保持一致。表单级错误集中显示，包含错误码与 requestId。
 */
export function LoginView({
  mode,
  onModeChange,
  pending,
  error,
  onSubmit,
  embedded = false,
  devLoginHref = null,
}: {
  mode: LoginMode;
  onModeChange: (mode: LoginMode) => void;
  pending: boolean;
  error: AppError | null;
  onSubmit: (values: LoginValues) => void;
  /** 嵌在既有布局里时按容器高度铺满，而不是占满整个视口。 */
  embedded?: boolean;
  /** 开发运行时提供的一步登录入口；生产构建与演示场景传 null 时不显示。 */
  devLoginHref?: string | null;
}) {
  const register = mode === "register";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    onSubmit(values(new FormData(event.currentTarget)));
  }

  return (
    <div
      data-testid="auth-screen"
      className={
        embedded
          ? "flex min-h-0 flex-1 flex-col bg-background text-foreground"
          : "flex min-h-dvh flex-col bg-background text-foreground"
      }
    >
      <main className="grid flex-1 place-items-center px-5 py-12 max-desktop:py-6">
        <form onSubmit={submit} aria-busy={pending} className="w-full max-w-90">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2.5 text-sm font-semibold tracking-[-0.02em]">
              <Icon as={Sprout} size={20} />
              Sprout Mio
            </span>
            <ThemeToggle />
          </div>

          <div className="mt-7 flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-container border border-border bg-secondary text-muted-foreground">
              <Icon as={Lock} size={18} />
            </span>
            <h1
              data-testid="auth-title"
              className="text-[1.625rem] leading-9 font-semibold tracking-[-0.03em]"
            >
              {register ? "创建工作空间账号" : "回到你的工作空间"}
            </h1>
          </div>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            与你的 Agent 分身，接着把事情做好。
          </p>

          <div
            role="group"
            aria-label="登录与注册"
            className="mt-7 mb-6 flex border-b border-border"
          >
            <button
              type="button"
              aria-pressed={!register}
              data-testid="login-tab"
              onClick={() => onModeChange("login")}
              className={`${tabClass} ${register ? "border-transparent text-muted-foreground hover:text-foreground" : "border-foreground font-semibold"}`}
            >
              登录
            </button>
            <button
              type="button"
              aria-pressed={register}
              data-testid="register-tab"
              onClick={() => onModeChange("register")}
              className={`${tabClass} ${register ? "border-foreground font-semibold" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              注册
            </button>
          </div>

          <div className="flex flex-col gap-5">
            {register && (
              <Field label="姓名" htmlFor="name">
                <Input
                  id="name"
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={80}
                  placeholder="你的名字"
                />
              </Field>
            )}
            <Field label="邮箱" htmlFor="email">
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="你的邮箱地址"
                aria-invalid={error ? true : undefined}
              />
            </Field>
            <Field label="密码" htmlFor="password" hint={register ? "至少 8 位" : undefined}>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                required
                minLength={8}
                maxLength={128}
                placeholder={register ? "至少 8 位密码" : "你的密码"}
                aria-invalid={error ? true : undefined}
              />
            </Field>
          </div>

          {error && (
            <div className="mt-5">
              <ResultError error={error} testId="auth-error" />
            </div>
          )}

          <Button
            type="submit"
            size="lg"
            loading={pending}
            data-testid="auth-submit"
            className="mt-6 w-full"
          >
            {pending ? "正在验证…" : register ? "创建账号" : "登录工作空间"}
          </Button>

          {devLoginHref && (
            <a
              href={devLoginHref}
              data-testid="dev-login"
              className="mt-3 flex min-h-8.5 items-center justify-center rounded-control border border-dashed border-border px-3 text-xs text-muted-foreground transition-colors hover:border-foreground hover:text-foreground max-desktop:min-h-11"
            >
              用开发账号直接进入
            </a>
          )}
        </form>
      </main>
      <footer className="pb-5 text-center text-xs text-muted-foreground">
        Sprout Mio · 人类与 Agent 的协作工作台
      </footer>
    </div>
  );
}
