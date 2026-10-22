import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { config } from "./config";
import { db } from "../db";
import * as schema from "../db/schema";

export function requireAuthSecret(settings: { BETTER_AUTH_SECRET?: string }): string {
  const secret = settings.BETTER_AUTH_SECRET;
  if (
    !secret ||
    secret.length < 32 ||
    secret === "local-development-only-replace-with-a-random-secret"
  ) {
    throw new Error(
      "环境变量校验失败 BETTER_AUTH_SECRET 必须设置为至少 32 字符的随机秘密，不能使用示例占位值",
    );
  }
  return secret;
}

export const auth = betterAuth({
  secret: requireAuthSecret(config),
  baseURL: config.APP_ORIGIN,
  trustedOrigins: [config.APP_ORIGIN, ...config.APP_TRUSTED_ORIGINS],
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: { enabled: true },
  rateLimit: {
    enabled: true,
    storage: "memory",
    window: config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    max: config.AUTH_RATE_LIMIT_HTTP_MAX,
    customRules: {
      "/sign-in/email": {
        window: config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
        max: config.AUTH_RATE_LIMIT_HTTP_MAX,
      },
      "/sign-up/email": {
        window: config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
        max: config.AUTH_RATE_LIMIT_HTTP_MAX,
      },
      "*": {
        window: config.AUTH_RATE_LIMIT_WINDOW_SECONDS,
        max: config.AUTH_RATE_LIMIT_HTTP_MAX,
      },
    },
  },
  plugins: [tanstackStartCookies()],
  databaseHooks: {
    user: {
      create: {
        /**
         * 注册成功后播种默认 Project 与默认 Agent。
         * 钩子位于注册事务提交之后，因此这里另开事务不会嵌套。
         * 播种失败不阻碍注册，记诊断后继续；`/projects` 分发点在零 Project 时提供新建入口兼底。
         */
        after: async (created) => {
          const userId = typeof created?.id === "string" ? created.id : undefined;
          if (!userId) return;
          const requestId = newId(ID_PREFIXES.request);
          try {
            const { createDefaultProjectForHuman } = await import("../domain/bootstrap");
            createDefaultProjectForHuman(userId, requestId);
          } catch (error) {
            console.error("[bootstrap] 默认 Project 创建失败", { requestId, error });
            try {
              const { recordDiagnostic } = await import("../server/diagnostics");
              recordDiagnostic({
                level: "error",
                event: "project.default_create_failed",
                requestId,
                message: "默认 Project 创建失败",
                data: { code: "internal" },
              });
            } catch {
              // 诊断本身失败时不再叠加错误，注册已经成功。
            }
          }
        },
      },
    },
  },
});
