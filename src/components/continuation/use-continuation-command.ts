import { useState } from "react";
import type {
  ChatContinuationCommand,
  ChatContinuationView,
} from "../../contracts/chat-continuation";
import { newId } from "../../contracts/ids";
import type {
  ContinuationAction,
  ContinuationDenials,
  ContinuationSubmit,
} from "./continuation-page-data";

export function useContinuationCommand(
  view: ChatContinuationView,
  denials: ContinuationDenials,
  onCommand?: ContinuationSubmit,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ reason: string; code: string } | null>(null);
  async function submit(action: ContinuationAction, targetId?: string) {
    if (!onCommand || pending || denials[action]) return false;
    const base = {
      projectId: view.projectId,
      chatId: view.chatId,
      expectedRevision: view.revision,
      requestId: newId("req"),
    };
    let command: ChatContinuationCommand;
    if (action === "abort")
      command = targetId ? { ...base, action, runId: targetId } : { ...base, action };
    else if (action === "retry") {
      if (!view.latestEvaluation || targetId !== view.latestEvaluation.evaluationId) return false;
      command = { ...base, action, evaluationId: targetId };
    } else if (action === "reissue") {
      if (!targetId) return false;
      command = { ...base, action, deliveryId: targetId, confirmedUnknown: true };
    } else command = { ...base, action };
    setPending(true);
    setError(null);
    try {
      const result = await onCommand(command);
      if (!result.ok) setError({ reason: result.error.reason, code: result.error.code });
      return result.ok;
    } catch {
      setError({ reason: "请求未完成，操作结果未知。请刷新事实后再操作。", code: "unknown" });
      return false;
    } finally {
      setPending(false);
    }
  }
  return { pending, error, submit, disabled: pending || !onCommand };
}
