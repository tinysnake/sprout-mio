/**
 * 可信 origin 判定。`APP_ORIGIN` 是主 origin（auth 的 baseURL、cookie 与回调都按它生成），
 * `APP_TRUSTED_ORIGINS` 提供同一进程可接受的其它内网 / VPN 地址。
 *
 * 模式里的 `*` 只匹配主机段中不跨层次的字符；模式本身已在配置解析时校验为回环或内网，
 * 所以这里不需要再判断网段，只需保证比较是整串匹配而不是前缀匹配。
 */
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function originMatchesPattern(pattern: string, origin: string): boolean {
  if (!pattern.includes("*")) return pattern === origin;
  const source = pattern.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${source}$`).test(origin);
}

/** 浏览器请求必须带 Origin，且它要么等于主 origin，要么命中显式配置的可信模式。 */
export function isTrustedOrigin(
  origin: string | null | undefined,
  appOrigin: string,
  trustedOrigins: readonly string[] = [],
): boolean {
  if (!origin) return false;
  return [appOrigin, ...trustedOrigins].some((pattern) => originMatchesPattern(pattern, origin));
}
