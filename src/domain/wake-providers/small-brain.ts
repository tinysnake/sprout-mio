import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import {
  decidedWakeResult,
  recipientKey,
  type WakeJudge,
  type WakeUsage,
} from "../wake-evaluation";
import { providerFailure, tokenCount, WakeProviderError, wakeInstructions } from "./shared";

const completionSchema = z.object({
  text: z.string(),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
});
const decisionsSchema = z.strictObject({
  decisions: z.array(
    z.strictObject({
      recipient: z.strictObject({ kind: z.enum(["agent", "human"]), id: z.string() }),
      decision: z.enum(["yes", "no", "unknown"]),
      certainty: z.enum(["high", "low"]),
      reason: z.string().trim().min(1).max(2000),
    }),
  ),
});
export type SmallBrainRequest = {
  agentDir: string;
  model: string;
  evaluatedAt: string;
  system: string;
  prompt: string;
  timeoutMs: number;
};
export type SmallBrainCompletion = z.infer<typeof completionSchema>;
export type SmallBrainOptions = {
  agentDir: string;
  clock: () => number;
  timeoutMs?: number;
  complete?: (request: SmallBrainRequest) => Promise<SmallBrainCompletion>;
};

/** Isolated no-session SDK completion; stdin carries only the bounded snapshot. */
function completeOnHost(request: SmallBrainRequest): Promise<SmallBrainCompletion> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve("scripts/pi-wake-runner.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    let overflow = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new WakeProviderError("provider_timeout", "Pi 小脑判定超时"));
    }, request.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1000000) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new WakeProviderError("provider_unavailable", "无法启动宿主 Pi 判定进程"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow) {
        reject(new WakeProviderError("provider_invalid_response", "Pi 判定响应超出预算"));
        return;
      }
      try {
        const value: unknown = JSON.parse(output);
        const failure = z
          .object({
            errorCode: z.enum([
              "provider_unavailable",
              "provider_auth_failed",
              "provider_invalid_response",
            ]),
          })
          .safeParse(value);
        if (code !== 0 && failure.success)
          throw new WakeProviderError(failure.data.errorCode, "宿主 Pi 模型或认证不可用");
        if (code !== 0) throw new WakeProviderError("provider_unavailable", "宿主 Pi 判定进程失败");
        accept(completionSchema.parse(value));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createSmallBrainJudge(options: SmallBrainOptions): WakeJudge {
  return async (input) => {
    const start = options.clock();
    const usage: WakeUsage = {
      inputTokens: null,
      outputTokens: null,
      inputCharacters: Array.from(JSON.stringify(input)).length,
      durationMs: 0,
    };
    try {
      if (input.policy.provider !== "small_brain")
        throw new WakeProviderError("provider_unavailable", "小脑不能处理其他 provider 的请求");
      const completion = completionSchema.parse(
        await (options.complete ?? completeOnHost)({
          agentDir: options.agentDir,
          model: input.policy.model,
          evaluatedAt: input.evaluatedAt,
          system: `${wakeInstructions}\n只输出 JSON，结构为 {"decisions":[{"recipient":{"kind":"agent|human","id":"候选 id"},"decision":"yes|no|unknown","certainty":"high|low","reason":"中文理由"}]}。每名候选恰有一项，禁止其他字段。certainty 是自报确定性，不是校准概率。`,
          prompt: JSON.stringify(input),
          timeoutMs: options.timeoutMs ?? 45000,
        }),
      );
      usage.inputTokens = completion.inputTokens;
      usage.outputTokens = completion.outputTokens;
      const parsed = decisionsSchema.parse(JSON.parse(completion.text));
      const expected = new Set(
        input.candidates.map((candidate) => recipientKey(candidate.recipient)),
      );
      const actual = parsed.decisions.map((item) => recipientKey(item.recipient));
      if (
        actual.length !== expected.size ||
        new Set(actual).size !== actual.length ||
        actual.some((key) => !expected.has(key))
      )
        throw new WakeProviderError("provider_invalid_response", "Pi 判定候选集合不匹配");
      return {
        result: decidedWakeResult(
          input,
          parsed.decisions.map((item) => ({
            recipient: item.recipient,
            decision: item.certainty === "low" ? "unknown" : item.decision,
            reason: item.reason,
            probability: null,
          })),
          "small_brain_certainty",
        ),
        usage,
      };
    } catch (error) {
      return providerFailure(input, error, usage);
    } finally {
      usage.durationMs = Math.max(0, options.clock() - start);
    }
  };
}
