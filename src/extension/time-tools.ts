import type { SproutExtensionAPI, SproutToolResult } from "./types";

export interface CurrentTimeInput {
  timezone?: string;
}

export interface CurrentTimeDetails {
  timezone: string;
  iso: string;
  utc: string;
  epochMs: number;
  offset: string;
  weekday: string;
}

function part(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string | undefined {
  return parts.find((entry) => entry.type === type)?.value;
}

function offsetFor(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const name = part(parts, "timeZoneName") ?? "GMT";
  if (name === "GMT") return "+00:00";
  const match = /^GMT([+-]\d{2}:\d{2})$/.exec(name);
  return match?.[1] ?? "+00:00";
}

/** 纯格式化函数，测试用固定 Date 注入，不依赖真实时钟。 */
export function formatCurrentTime(timeZone: string, now: Date): CurrentTimeDetails {
  // 非法 IANA 时区会在这里抛 RangeError，由工具层转成可读错误。
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const year = part(parts, "year") ?? "0000";
  const month = part(parts, "month") ?? "00";
  const day = part(parts, "day") ?? "00";
  const hour = part(parts, "hour") ?? "00";
  const minute = part(parts, "minute") ?? "00";
  const second = part(parts, "second") ?? "00";
  const millisecond = String(now.getUTCMilliseconds()).padStart(3, "0");
  const offset = offsetFor(timeZone, now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(now);
  return {
    timezone: timeZone,
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}${offset}`,
    utc: now.toISOString(),
    epochMs: now.getTime(),
    offset,
    weekday,
  };
}

function timeText(facts: CurrentTimeDetails): string {
  const local = facts.iso.slice(0, 19).replace("T", " ");
  return [
    `${local} ${facts.offset} (${facts.timezone}, ${facts.weekday})`,
    `UTC ${facts.utc}`,
    `epoch ${facts.epochMs}`,
  ].join("\n");
}

function fail(message: string): SproutToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { error: message },
    isError: true,
  };
}

/** 注册宿主时钟工具。始终只读，不随租约出现或消失。 */
export function registerCurrentTimeTool(pi: SproutExtensionAPI): void {
  pi.registerTool({
    name: "current_time",
    label: "Current Time",
    description:
      "返回宿主机器当前时间、IANA 时区、UTC、epoch 毫秒和星期。需要判断今天日期、时区或事件先后时调用；默认使用宿主时区，可传 timezone 指定 IANA 名称。",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: "IANA 时区名，例如 Asia/Shanghai；省略时使用宿主时区。",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, parameters): Promise<SproutToolResult> {
      const input = parameters as CurrentTimeInput | null;
      if (input !== null && (typeof input !== "object" || Array.isArray(input))) {
        return fail("current_time 参数必须是对象。");
      }
      const requested = input?.timezone;
      if (requested !== undefined && typeof requested !== "string") {
        return fail("timezone 必须是 IANA 时区名字符串。");
      }
      const timeZone =
        requested?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      try {
        const facts = formatCurrentTime(timeZone, new Date());
        return {
          content: [{ type: "text", text: timeText(facts) }],
          details: { ...facts },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return fail(`未知或不可用的时区 ${JSON.stringify(timeZone)}：${reason}`);
      }
    },
  });
}
