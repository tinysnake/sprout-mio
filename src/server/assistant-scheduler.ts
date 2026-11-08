import { sampleAssistantRuns } from "../domain/assistant-observer";
export function createAssistantScheduler(onError: (error: unknown) => void = console.error) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  function arm() {
    if (!started) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!started) return;
      try {
        sampleAssistantRuns(new Date());
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
        arm();
      }
    },
    stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
export type AssistantScheduler = ReturnType<typeof createAssistantScheduler>;
