import {
  claimAssistantWatchSummaries,
  finishAssistantWatchSummary,
} from "../../src/domain/assistant-watch-summary";
import { deliverAssistantEvents } from "../../src/domain/assistant";

export function settleWatchSummaries(
  now: Date,
  text = "本窗口有新的工作讨论；尚无已验证的业务结果。",
) {
  for (;;) {
    const claims = claimAssistantWatchSummaries(now);
    if (!claims.length) break;
    for (const claim of claims)
      finishAssistantWatchSummary(
        claim,
        {
          summary: text,
          model: "test/semantic",
          effort: "off",
        },
        now,
      );
  }
  deliverAssistantEvents(now);
}
