import { createServerFn } from "@tanstack/react-start";
import { ok } from "../contracts/result";
import type { DevLoginSettings } from "../lib/config";
import { getRequestContext } from "./request-context";

/**
 * 开发登录：`/dev-login` 用固定账号建会话，把会话 cookie 写进重定向响应，让远程
 * 评审直接打开页面就处在登录态，不必手输长账号密码。
 *
 * 两个开关同时成立才开放：构建期 `import.meta.env.DEV`（只有 dev server 为真）与
 * `DEV_LOGIN_ENABLED`。生产构建与验收库都不满足，路由在那里返回 404。会话来自
 * better-auth 的正常登录，因此登出、`getSession`、cookie 属性与身份判定仍走原有
 * 路径，没有第二条鉴权分支。
 *
 * 本模块的类型会进入登录页的客户端产物，所以配置在调用时动态读取，不在顶层
 * 引入只属于服务端的模块。
 */
async function settings(): Promise<DevLoginSettings> {
  const { config } = await import("../lib/config");
  return config;
}

/** 诊断写入按需加载，避免登录页的客户端产物牵进服务端的数据库模块。 */
async function diagnose(input: Parameters<typeof import("./diagnostics").recordDiagnostic>[0]) {
  const { recordDiagnostic } = await import("./diagnostics");
  recordDiagnostic(input);
}

export async function devLoginEnabled(): Promise<boolean> {
  return import.meta.env.DEV && (await settings()).DEV_LOGIN_ENABLED;
}

/**
 * `/dev-login?to=/projects` 只接受站内绝对路径，挡住 `//evil` 之类的开放跳转；
 * 不合法或缺失时落到 `/`，由应用既有的分发决定最终页面。
 */
export function devLoginTarget(search: string): string {
  const to = new URLSearchParams(search).get("to");
  if (!to || !to.startsWith("/") || to.startsWith("//") || to.includes("\\")) return "/";
  return to;
}

/**
 * 让配置里的账号密码成为可登录的凭据，再走正常登录拿到 cookie。
 *
 * 同一次请求里注册会用 better-auth 的既有钩子播种默认 Project，因此新库第一次
 * 打开 `/dev-login` 就能直接进入可用工作空间；账号已存在时只把密码对齐到配置值，
 * 不重建用户或 Project。这些写操作只发生在 dev server 的开发登录里。
 */
async function signIn(config: DevLoginSettings): Promise<string[]> {
  const { auth } = await import("../lib/auth");
  const context = await auth.$context;
  const email = config.DEV_LOGIN_EMAIL;
  const password = config.DEV_LOGIN_PASSWORD;
  const endpoint = (path: string) =>
    new Request(`${config.APP_ORIGIN}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: config.APP_ORIGIN },
    });
  const existing = await context.internalAdapter.findUserByEmail(email);
  if (!existing) {
    const request = endpoint("sign-up/email");
    const created = await auth.api.signUpEmail({
      body: { email, password, name: config.DEV_LOGIN_NAME },
      headers: request.headers,
      request,
      asResponse: true,
    });
    if (!created.ok) throw new Error(`开发登录注册失败：${await created.text()}`);
    return created.headers.getSetCookie();
  }
  const credential = await context.internalAdapter.findCredentialAccount(existing.user.id);
  const matches =
    Boolean(credential?.password) &&
    (await context.password.verify({ hash: credential!.password!, password }));
  if (!matches) await context.internalAdapter.updatePassword(existing.user.id, password);
  const request = endpoint("sign-in/email");
  const session = await auth.api.signInEmail({
    body: { email, password },
    headers: request.headers,
    request,
    asResponse: true,
  });
  if (!session.ok) throw new Error(`开发登录失败：${await session.text()}`);
  return session.headers.getSetCookie();
}

/** 直接把会话 cookie 写进 303，让浏览器一次往返就带着登录态落到目标页面。 */
export async function devLoginResponse(request: Request, requestId: string): Promise<Response> {
  const config = await settings();
  const headers = new Headers({
    location: devLoginTarget(new URL(request.url).search),
    "cache-control": "no-store",
  });
  try {
    for (const cookie of await signIn(config)) headers.append("set-cookie", cookie);
  } catch (error) {
    await diagnose({
      level: "error",
      event: "auth.dev_login_failed",
      requestId,
      message: "开发登录失败",
      data: { error: error instanceof Error ? error.message : "未知错误" },
    });
    return new Response("开发登录失败", { status: 500, headers: { "cache-control": "no-store" } });
  }
  await diagnose({
    level: "info",
    event: "auth.dev_login",
    requestId,
    message: "开发登录创建会话",
    data: { email: config.DEV_LOGIN_EMAIL },
  });
  return new Response(null, { status: 303, headers });
}

/** 登录页据此决定是否显示「开发账号直接进入」，生产构建返回 enabled=false。 */
export const getDevLoginStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { requestId } = getRequestContext();
  return ok(
    (await devLoginEnabled())
      ? ({ enabled: true, href: "/dev-login?to=/" } as const)
      : ({ enabled: false, href: null } as const),
    requestId,
  );
});
