import { z } from "zod";
import type { WakeEvaluationInput } from "../../contracts/wake-evaluation";
import {
  decidedWakeResult,
  recipientKey,
  type WakeJudge,
  type WakeUsage,
} from "../wake-evaluation";
import { providerFailure, tokenCount, WakeProviderError, wakeInstructions } from "./shared";

export const JEV_MODEL = "jev-1.14.0";
export type JevThreshold = { version: string; yes: number; no: number };
export type JevOptions = {
  apiKey: string | undefined;
  threshold: JevThreshold;
  clock: () => number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};
const responseSchema = z.object({
  model: z.literal(JEV_MODEL),
  answers: z.record(
    z.string(),
    z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  ),
  usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }),
});

/** Independent Noul questions; never a Choice contest or a provider fallback. */
export function createJevJudge(options: JevOptions): WakeJudge {
  return async (input: WakeEvaluationInput) => {
    const start = options.clock();
    const usage: WakeUsage = {
      inputTokens: null,
      outputTokens: null,
      inputCharacters: Array.from(JSON.stringify(input)).length,
      durationMs: 0,
    };
    try {
      if (!options.apiKey?.trim())
        throw new WakeProviderError(
          "provider_unavailable",
          "缺少独立 JEV 服务凭据 JEV_API_KEY",
        );
      if (input.policy.provider !== "jev" || input.policy.model !== JEV_MODEL)
        throw new WakeProviderError("provider_unavailable", `JEV 仅支持固定 model ${JEV_MODEL}`);
      const threshold = options.threshold;
      if (
        threshold.version !== input.policy.thresholdVersion ||
        !(0 <= threshold.no && threshold.no < threshold.yes && threshold.yes <= 1)
      )
        throw new WakeProviderError("provider_unavailable", "缺少匹配版本的 JEV 判定阈值");
      if (!input.candidates.length)
        throw new WakeProviderError("provider_invalid_response", "JEV 请求需要候选");
      const questions = Object.fromEntries(
        input.candidates.map((candidate, index) => [
          `candidate_${index}`,
          {
            type: "noul",
            instructions: `${wakeInstructions}\n候选身份：${recipientKey(candidate.recipient)}；人设：${candidate.personaSummary}；职责：${candidate.responsibility}。根据 state，这名候选现在是否需要发言、继续工作或（Human）回应？`,
          },
        ]),
      );
      const response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state: input, questions }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      });
      if (!response.ok)
        throw new WakeProviderError(
          response.status === 401 || response.status === 403
            ? "provider_auth_failed"
            : "provider_unavailable",
          `JEV HTTP ${response.status}`,
        );
      const data = responseSchema.parse(await response.json());
      usage.inputTokens = data.usage.input_tokens;
      usage.outputTokens = data.usage.output_tokens;
      if (Object.keys(data.answers).length !== input.candidates.length)
        throw new WakeProviderError("provider_invalid_response", "JEV 候选回答数量不匹配");
      const recipients = input.candidates.map((candidate, index) => {
        const answer = data.answers[`candidate_${index}`];
        if (!answer) throw new WakeProviderError("provider_invalid_response", "JEV 缺少候选回答");
        const probability = answer.noul;
        return {
          recipient: candidate.recipient,
          decision:
            probability >= threshold.yes
              ? ("yes" as const)
              : probability <= threshold.no
                ? ("no" as const)
                : ("unknown" as const),
          reason: `JEV 独立 yes 概率 ${probability}；阈值版本 ${threshold.version}`,
          probability,
        };
      });
      return { result: decidedWakeResult(input, recipients, "jev_noul"), usage };
    } catch (error) {
      return providerFailure(input, error, usage);
    } finally {
      usage.durationMs = Math.max(0, options.clock() - start);
    }
  };
}
