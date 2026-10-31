import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { EvaluateWake } from "../domain/continuation-delivery";
import { evaluateWake } from "../domain/wake-evaluation";
import { createJevJudge, type JevOptions } from "../domain/wake-providers/jev";
import {
  createSmallBrainJudge,
  type SmallBrainOptions,
} from "../domain/wake-providers/small-brain";

export type WakeRuntimeOptions = {
  clock: () => number;
  complete?: SmallBrainOptions["complete"];
  fetch?: JevOptions["fetch"];
};

function hostDefaultModel(agentDir: string): string {
  const defaults = z
    .object({ defaultProvider: z.string().min(1), defaultModel: z.string().min(1) })
    .parse(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")));
  return `${defaults.defaultProvider}/${defaults.defaultModel}`;
}

/** Keeps the scheduler result-only while the provider boundary validates the full receipt. */
export function createWakeEvaluator(options: WakeRuntimeOptions): EvaluateWake {
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  return async (input) => {
    const judges = {
      small_brain: createSmallBrainJudge({
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
      input.policy.provider === "small_brain" && !input.policy.model
        ? { ...input, policy: { ...input.policy, model: hostDefaultModel(agentDir) } }
        : input;
    return (await evaluateWake(request, judges)).result;
  };
}
