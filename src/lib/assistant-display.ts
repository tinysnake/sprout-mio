import { ID_PREFIXES } from "../contracts/ids";

const internalId = new RegExp(`\\b(?:${Object.values(ID_PREFIXES).join("|")})_[a-z0-9]+\\b`, "gi");

export function assistantTextPreview(body: string, limit = 180): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const request = paragraphs.find((part) =>
    /^(?:请|帮|让|检查|修复|创建|更新|发送|安排|please\b)/i.test(part),
  );
  const text = (request ?? paragraphs[0] ?? body)
    .replace(internalId, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function assistantDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3600
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
