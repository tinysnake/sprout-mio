import { z } from "zod";
import { SLEEP_MAX_MS, SLEEP_MIN_MS } from "../contracts/tool-wait";
import { objectToolParameters } from "./tool-parameters";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

const sleepInputSchema = z.strictObject({ ms: z.number().min(SLEEP_MIN_MS) });

function sleepResult(details: Record<string, unknown>, isError = false): SproutToolResult {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError };
}

async function runSleep(requestedMs: number, signal?: AbortSignal): Promise<SproutToolResult> {
  if (signal?.aborted) return sleepResult({ outcome: "cancelled" });
  const sleptMs = Math.min(requestedMs, SLEEP_MAX_MS);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve(
        signal?.aborted
          ? sleepResult({ outcome: "cancelled" })
          : sleepResult({ outcome: "slept", sleptMs, requestedMs, now: new Date().toISOString() }),
      );
    };
    const timer = setTimeout(done, sleptMs);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function registerSleepTool(pi: Pick<SproutExtensionAPI, "registerTool">): void {
  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    description: `在宿主本地等待 ms 毫秒（必填且至少 ${SLEEP_MIN_MS} 毫秒），最多等待 ${SLEEP_MAX_MS / 60_000} 分钟；超出上限会钳断并回报 requestedMs 与 sleptMs。成功返回当前 ISO 时间 now，等待期间可取消。`,
    parameters: objectToolParameters(sleepInputSchema),
    async execute(_toolCallId, parameters, signal) {
      const parsed = sleepInputSchema.safeParse(parameters);
      if (!parsed.success)
        return sleepResult(
          {
            outcome: "invalid_input",
            message: `ms 必须是至少 ${SLEEP_MIN_MS} 的有限毫秒数，且不得附带其他参数。`,
          },
          true,
        );
      return runSleep(parsed.data.ms, signal);
    },
  });
}

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
