import { sampleAssistantRuns } from "../domain/assistant-observer";
import { createAssistantWatchSummaryWorker } from "./assistant-watch-summary";
export function createAssistantScheduler(onError: (error: unknown) => void = console.error) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let summaries = createAssistantWatchSummaryWorker(onError);
  function arm() {
    if (!started) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!started) return;
      try {
        sampleAssistantRuns(new Date());
        summaries.tick();
      } catch (error) {
        onError(error);
      }
      arm();
    }, 1000);
    timer.unref();
  }
  return {
    start() {
      if (!started) {
        started = true;
        summaries = createAssistantWatchSummaryWorker(onError);
        arm();
      }
    },
    stop() {
      started = false;
      summaries.stop();
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
export type AssistantScheduler = ReturnType<typeof createAssistantScheduler>;
