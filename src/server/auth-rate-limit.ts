import { createHash } from "node:crypto";
import { config } from "../lib/config";
import { createSlidingWindowLimiter } from "./rate-limit";

function createAuthLimiter() {
  const windowMs = config.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000;
  const account = createSlidingWindowLimiter({ max: config.AUTH_RATE_LIMIT_MAX, windowMs });
  const total = createSlidingWindowLimiter({
    max: config.AUTH_RATE_LIMIT_GLOBAL_MAX,
    windowMs,
    maxKeys: 1,
  });
  return (email: string) => {
    const globalDecision = total("authenticate");
    if (!globalDecision.allowed) return globalDecision;
    // Better Auth 的邮箱查找同样使用 toLowerCase；不将可伪造代理头纳入身份。
    const key = createHash("sha256").update(email.toLowerCase()).digest("hex");
    return account(key);
  };
}

const processCache = globalThis as typeof globalThis & {
  sproutAuthLimiter?: ReturnType<typeof createAuthLimiter>;
};

/** login/register 共用账号预算；HMR 模块求值不会重置进程预算。 */
export const consumeAuthAttempt = (processCache.sproutAuthLimiter ??= createAuthLimiter());
