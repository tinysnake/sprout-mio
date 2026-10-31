/** Only same-origin application paths may survive authentication. */
export function safeReturnTarget(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://sprout.invalid");
    if (url.origin !== "https://sprout.invalid" || url.pathname === "/login" || url.pathname.startsWith("/api/")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/"; }
}
