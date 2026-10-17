import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
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
  trustedOrigins: [config.APP_ORIGIN],
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
});
