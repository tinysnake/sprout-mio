import { z } from "zod";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DIAGNOSTIC_LEVELS } from "../contracts/diagnostics";

/** 回环、私有网段、链路本地与 CGNAT 都属内网可达，其余地址不放行。 */
function isInternalAddress(octets: readonly number[]): boolean {
  const [a, b] = octets;
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * 主机段要么是 `localhost` / `*.localhost` / `*.local` / `*`，要么是四段 IPv4
 * 模式，且 `*` 只能替换末尾一段，例如 `192.168.50.*`。展开后必须落在内网网段，
 * 所以 `http://*.example.com` 与 `http://8.8.*` 都不成立。
 */
function isInternalHostPattern(hostname: string): boolean {
  const name = hostname.toLowerCase();
  if (name === "localhost" || name === "*.localhost" || name === "*.local") return true;
  const labels = name.split(".");
  const wildcard = labels.at(-1) === "*";
  const fixed = wildcard ? labels.slice(0, -1) : labels;
  if (fixed.length === 0 || fixed.length > 4) return false;
  if (!fixed.every((label) => /^\d{1,3}$/.test(label) && Number(label) <= 255)) return false;
  if (fixed.length === 4 && wildcard) return false;
  const octets = fixed.map(Number);
  while (octets.length < 4) octets.push(0);
  return isInternalAddress(octets);
}

const originPatternSchema = z
  .string()
  .min(1)
  .refine((value) => {
    const match = /^(https?):\/\/([^/?#@]+)$/.exec(value);
    if (!match) return false;
    const host = match[2];
    if (!/^(?:[a-z0-9.*-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(host)) return false;
    const port = host.includes(":") ? Number(host.slice(host.lastIndexOf(":") + 1)) : undefined;
    if (port !== undefined && (port < 1 || port > 65535)) return false;
    return isInternalHostPattern(host.replace(/:\d+$/, ""));
  }, "必须是回环或内网 origin，主机段可用 * 通配");

const environmentSchema = z.object({
  SPROUT_PI_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  SPROUT_PI_DATA_DIR: z
    .string()
    .min(1)
    .refine(isAbsolute, "必须是绝对路径")
    .default(join(homedir(), ".local", "share", "sprout-mio", "pi")),
  SPROUT_PI_RUNNER: z
    .string()
    .min(1)
    .refine((value) => {
      if (!isAbsolute(value)) return false;
      try {
        accessSync(value, constants.F_OK | constants.X_OK);
        return statSync(value).isFile();
      } catch {
        return false;
      }
    }, "必须是存在且可执行的绝对路径")
    .optional(),
  SPROUT_REPO_DIR: z
    .string()
    .min(1)
    .refine(isAbsolute, "必须是绝对路径")
    .default(join(homedir(), ".local", "share", "sprout-mio", "repos")),
  SPROUT_REPO_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(2 * 1024 * 1024 * 1024),
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
  /**
   * 额外的可信 origin（逗号分隔，可用内网通配）。`APP_ORIGIN` 始终可信；这里用于
   * 同一进程经不同内网 / VPN 地址访问，例如 `http://192.168.50.*:3210`。
   */
  APP_TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(originPatternSchema)),
  /**
   * 开发登录：dev server 上把固定账号写进会话 cookie 后跳到目标页面，省掉手输长账号
   * 密码。只在构建期 `import.meta.env.DEV` 为真的 dev server 生效，生产构建与验收库
   * 一律没有这个入口；把它设成 false 可以关掉（例如 dev server 暴露在不信任网络里）。
   */
  DEV_LOGIN_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  DEV_LOGIN_EMAIL: z.email().default("dev@sprout.test"),
  DEV_LOGIN_NAME: z.string().trim().min(1).max(80).default("开发评审"),
  DEV_LOGIN_PASSWORD: z.string().min(8).max(128).default("sprout-dev-login"),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(5),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  AUTH_RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().min(1).max(10_000).default(100),
  AUTH_RATE_LIMIT_HTTP_MAX: z.coerce.number().int().min(1).max(10_000).default(100),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(DIAGNOSTIC_LEVELS).default("info"),
});

/** 开发登录相关配置的类型；登录页只需要这几个值，不引入服务端模块。 */
export type DevLoginSettings = Pick<
  ReturnType<typeof parseConfig>,
  "APP_ORIGIN" | "DEV_LOGIN_ENABLED" | "DEV_LOGIN_EMAIL" | "DEV_LOGIN_NAME" | "DEV_LOGIN_PASSWORD"
>;

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
