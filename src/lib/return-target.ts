/** Only same-origin application paths may survive authentication. */
export function safeReturnTarget(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) <= 32 || value[index] === "\\") return "/";
  try {
    const url = new URL(value, "https://sprout.invalid");
    if (
      url.origin !== "https://sprout.invalid" ||
      url.pathname.replace(/\/+$/, "") === "/login" ||
      url.pathname.startsWith("/api/")
    )
      return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
