import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  claimAssistantWatchSummaries,
  finishAssistantWatchSummary,
  type WatchSummaryClaim,
} from "../domain/assistant-watch-summary";
import { deliverAssistantEvents } from "../domain/assistant";

export function runAssistantWatchSummary(claim: WatchSummaryClaim, signal?: AbortSignal) {
  return new Promise<{ summary: string; model: string; effort: string }>((accept, reject) => {
    const child = execFile(
      process.execPath,
      [resolve("scripts/pi-watch-summary.mjs")],
      {
        timeout: 90_000,
        killSignal: "SIGKILL",
        maxBuffer: 32_768,
        signal,
        env: { ...process.env },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("watch_summary_process_failed"));
          return;
        }
        try {
          const result: unknown = JSON.parse(stdout);
          if (
            !result ||
            typeof result !== "object" ||
            !("summary" in result) ||
            typeof result.summary !== "string" ||
            !("model" in result) ||
            typeof result.model !== "string" ||
            !("effort" in result) ||
            typeof result.effort !== "string"
          )
            throw new Error("watch_summary_output_invalid");
          accept({ summary: result.summary, model: result.model, effort: result.effort });
        } catch {
          reject(new Error("watch_summary_output_invalid"));
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({
        agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
        profile: claim.profile,
        fact: claim.event.fact,
      }),
    );
  });
}
export function createAssistantWatchSummaryWorker(onError: (error: unknown) => void) {
  const active = new Map<string, AbortController>();
  let stopped = false;
  return {
    tick(now = new Date()) {
      if (stopped) return;
      const claims = claimAssistantWatchSummaries(now, Math.max(0, 2 - active.size));
      for (const claim of claims) {
        const controller = new AbortController();
        active.set(claim.token, controller);
        void runAssistantWatchSummary(claim, controller.signal)
          .then((result) => {
            finishAssistantWatchSummary(claim, result);
          })
          .catch(() => {
            finishAssistantWatchSummary(claim, { error: "watch_summary_model_failed" });
          })
          .then(() => {
            deliverAssistantEvents(new Date());
          })
          .catch(onError)
          .finally(() => {
            active.delete(claim.token);
          });
      }
    },
    stop() {
      stopped = true;
      for (const controller of active.values()) controller.abort();
    },
  };
}
