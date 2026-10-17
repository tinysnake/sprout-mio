import { z } from "zod";
import { DIAGNOSTIC_LEVELS } from "../contracts/diagnostics";

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1).default("./data/sprout.sqlite"),
  APP_ORIGIN: z
    .url()
    .pipe(
      z.string().refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && url.origin === value;
      }, "必须是 http 或 https origin"),
    )
    .default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(DIAGNOSTIC_LEVELS).default("info"),
});

/** 环境只在边界解析，返回值冻结，后续模块不能改写配置。 */
export function parseConfig(env: Record<string, string | undefined>) {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message);
    throw new Error("环境变量校验失败 " + fields.join("; "));
  }
  return Object.freeze(parsed.data);
}

export const config = parseConfig(process.env);
