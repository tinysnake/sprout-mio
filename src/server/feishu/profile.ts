import type { FeishuTransportConfig } from "../../contracts/feishu-channel";
import type { FeishuHttpTransport, FeishuTokenSource } from "./emission";

const PROFILE_TIMEOUT_MS = 5_000;
export const MAX_NICKNAME_CHARS = 64;

/**
 * 昵称只是展示信息，缺权限、超时、结构不对都退回 null，绝不阻塞绑定确认。
 */
export async function fetchFeishuNickname(input: {
  config: Pick<FeishuTransportConfig, "origin">;
  transport: FeishuHttpTransport;
  tokens: FeishuTokenSource;
  openId: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const openId = input.openId.trim();
  if (!openId) return null;
  try {
    const authorization = await input.tokens.get();
    const exchange = input.transport({
      method: "GET",
      url: `${input.config.origin}/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
      headers: { authorization: `Bearer ${authorization}`, accept: "application/json" },
      body: "",
      timeoutMs: input.timeoutMs ?? PROFILE_TIMEOUT_MS,
    });
    const reply = await exchange.response;
    if (reply.status !== 200) return null;
    return readName(reply.body);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readName(body: string): string | null {
  const user = record(record(JSON.parse(body))?.data)?.user;
  const name = record(user)?.name;
  if (typeof name !== "string") return null;
  const clean = name.trim().slice(0, MAX_NICKNAME_CHARS);
  return clean === "" ? null : clean;
}
