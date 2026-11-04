import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { config } from "../lib/config";
import type { EvaluateWake } from "../domain/continuation-delivery";
import { evaluateWake } from "../domain/wake-evaluation";
import { createJevJudge, type JevOptions } from "../domain/wake-providers/jev";
import { createLlmJudge, type LlmOptions } from "../domain/wake-providers/llm";

export type WakeRuntimeOptions = {
  clock: () => number;
  complete?: LlmOptions["complete"];
  fetch?: JevOptions["fetch"];
};

function hostDefaultModel(agentDir: string): string {
  const defaults = z
    .object({ defaultProvider: z.string().min(1), defaultModel: z.string().min(1) })
    .parse(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")));
  return `${defaults.defaultProvider}/${defaults.defaultModel}`;
}

/** Provider 边界已经校验过整份回执；调度器要的是 usage，不是再拆一层。 */
export function createWakeEvaluator(options: WakeRuntimeOptions): EvaluateWake {
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  return async (input) => {
    if (!config.SPROUT_CONTINUATION_ENABLED) throw new Error("provider_unavailable");
    const judges = {
      llm: createLlmJudge({
        agentDir,
        clock: options.clock,
        complete: options.complete,
      }),
      jev: createJevJudge({
        apiKey: process.env.JEV_API_KEY,
        threshold: { version: "p6a-design-default-v1", yes: 0.8, no: 0.2 },
        clock: options.clock,
        fetch: options.fetch,
      }),
    };
    const request =
      input.policy.provider === "llm" && !input.policy.model
        ? { ...input, policy: { ...input.policy, model: hostDefaultModel(agentDir) } }
        : input;
    return await evaluateWake(request, judges);
  };
}
