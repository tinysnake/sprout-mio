import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { fail, ok, toAppError } from "../contracts/result";
import type { AppResult } from "../contracts/result";
import { ID_PREFIXES, newId } from "../contracts/ids";

export type SessionInfo = {
  userId: string;
  email: string;
  name: string;
  expiresAt: string;
};

export const readSession = createServerOnlyFn(
  async (headers: Headers): Promise<SessionInfo | null> => {
    const { auth } = await import("../lib/auth");
    const result = await auth.api.getSession({ headers });
    if (!result) return null;
    return {
      userId: result.user.id,
      email: result.user.email,
      name: result.user.name,
      expiresAt: result.session.expiresAt.toISOString(),
    };
  },
);

export async function requireSession(
  headers: Headers,
  requestId: string,
): Promise<AppResult<SessionInfo>> {
  const session = await readSession(headers);
  return session
    ? ok(session, requestId)
    : fail({ code: "unauthorized", message: "请先登录", requestId });
}

export const getSessionInfo = createServerFn({ method: "GET" }).handler(async () => {
  const requestId = newId(ID_PREFIXES.request);
  try {
    return ok(await readSession(getRequestHeaders()), requestId);
  } catch (error) {
    return fail(toAppError(error, requestId));
  }
});

export const getProtectedSession = createServerFn({ method: "GET" }).handler(async () => {
  const requestId = newId(ID_PREFIXES.request);
  try {
    return await requireSession(getRequestHeaders(), requestId);
  } catch (error) {
    return fail(toAppError(error, requestId));
  }
});

const credentials = {
  email: z.email(),
  password: z.string().min(8).max(128),
};
const authInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("register"),
    ...credentials,
    name: z.string().trim().min(1).max(80),
  }),
  z.object({ action: z.literal("login"), ...credentials }),
  z.object({ action: z.literal("logout") }),
]);
export type AuthInput = z.infer<typeof authInput>;

export const authenticate = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<AppResult<{ userId: string } | null>> => {
    const { getRequestContext } = await import("./request-context");
    const { requestId } = getRequestContext();
    const parsed = authInput.safeParse(data);
    if (!parsed.success) return fail(toAppError(parsed.error, requestId));
    const headers = getRequestHeaders();
    const { config } = await import("../lib/config");
    if (headers.get("origin") !== config.APP_ORIGIN) {
      return fail({ code: "forbidden", message: "请求来源不受信任", requestId });
    }
    const input = parsed.data;
    if (input.action !== "logout") {
      const { consumeAuthAttempt } = await import("./auth-rate-limit");
      if (!consumeAuthAttempt(input.email).allowed) {
        const message = "尝试过于频繁，请稍后再试";
        const { recordDiagnostic } = await import("./diagnostics");
        recordDiagnostic({
          level: "warn",
          event: "auth.rate_limited",
          requestId,
          message,
          data: { action: input.action },
        });
        return fail({ code: "too_many_requests", message, requestId });
      }
    }
    const { auth } = await import("../lib/auth");
    const { APIError } = await import("better-auth/api");
    try {
      switch (input.action) {
        case "register": {
          const result = await auth.api.signUpEmail({ body: input, headers });
          return ok({ userId: result.user.id }, requestId);
        }
        case "login": {
          const result = await auth.api.signInEmail({ body: input, headers });
          return ok({ userId: result.user.id }, requestId);
        }
        case "logout":
          await auth.api.signOut({ headers });
          return ok(null, requestId);
      }
    } catch (error) {
      if (error instanceof APIError) {
        switch (error.statusCode) {
          case 400:
          case 422:
            return fail({
              code: "validation_failed",
              message: "输入无效或无法使用该邮箱注册",
              requestId,
            });
          case 401:
            return fail({ code: "unauthorized", message: "邮箱或密码不正确", requestId });
          case 403:
            return fail({ code: "forbidden", message: "请求来源不受信任", requestId });
          case 409:
            return fail({ code: "conflict", message: "无法使用该邮箱注册", requestId });
        }
      }
      return fail(toAppError(error, requestId));
    }
  });
