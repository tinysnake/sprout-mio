import { and, eq, isNull } from "drizzle-orm";
import { db, sqlite } from "../db";
import { agentInstance, agentRun, agentRunInput, message, webhookTrigger } from "../db/schema";
import { resolveAutomationTarget } from "./automation-target";

function valid(runId: string, messageId: string): boolean {
  const run = db.select().from(agentRun).where(eq(agentRun.id, runId)).get();
  const saved = db.select().from(message).where(eq(message.id, messageId)).get();
  const trigger = saved?.automationTriggerId
    ? db.select().from(webhookTrigger).where(eq(webhookTrigger.id, saved.automationTriggerId)).get()
    : undefined;
  if (
    !run ||
    !saved ||
    !trigger ||
    saved.senderKind !== "automation" ||
    trigger.decision !== "accepted" ||
    trigger.messageId !== saved.id ||
    trigger.chatId !== run.chatId ||
    saved.chatId !== run.chatId ||
    trigger.projectId !== run.projectId ||
    !["queued", "running"].includes(run.status)
  )
    return false;
  const instance = db
    .select()
    .from(agentInstance)
    .where(eq(agentInstance.id, run.instanceId))
    .get();
  if (
    !instance ||
    instance.agentProfileId !== trigger.agentProfileId ||
    instance.chatId !== run.chatId ||
    instance.projectId !== run.projectId
  )
    return false;
  const target = resolveAutomationTarget(trigger.projectId, trigger.snapshot.action, {
    userId: trigger.snapshot.createdBy,
    requestId: run.requestId,
  });
  return (
    !("reason" in target) &&
    target.chatId === trigger.chatId &&
    target.agentProfileId === trigger.agentProfileId
  );
}
function cancel(runId: string, messageId: string) {
  db.update(agentRunInput)
    .set({
      disposition: "cancelled",
      cancelledAt: new Date(),
      cancelReason: "automation_context_changed",
    })
    .where(
      and(
        eq(agentRunInput.runId, runId),
        eq(agentRunInput.messageId, messageId),
        eq(agentRunInput.disposition, "pending"),
        isNull(agentRunInput.admittedAt),
      ),
    )
    .run();
}
export function cancelInvalidAutomationInputs(runId: string): void {
  sqlite
    .transaction(() => {
      const inputs = db
        .select({ id: message.id })
        .from(agentRunInput)
        .innerJoin(message, eq(message.id, agentRunInput.messageId))
        .where(
          and(
            eq(agentRunInput.runId, runId),
            eq(agentRunInput.disposition, "pending"),
            isNull(agentRunInput.admittedAt),
            eq(message.senderKind, "automation"),
          ),
        )
        .all();
      for (const input of inputs) if (!valid(runId, input.id)) cancel(runId, input.id);
    })
    .immediate();
}

/** Persist the send attempt under the same writer lock as the last authority check; never retry an uncertain send. */
export function admitAutomationInput<T>(
  runId: string,
  messageId: string,
  send: () => T,
): T | undefined {
  let result: T | undefined;
  let failure: { error: unknown } | undefined;
  sqlite
    .transaction(() => {
      const input = db
        .select()
        .from(agentRunInput)
        .where(and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, messageId)))
        .get();
      if (!input || input.disposition !== "pending" || input.admittedAt) return;
      if (!valid(runId, messageId)) {
        cancel(runId, messageId);
        return;
      }
      db.update(agentRunInput)
        .set({ admittedAt: new Date() })
        .where(and(eq(agentRunInput.runId, runId), eq(agentRunInput.messageId, messageId)))
        .run();
      try {
        result = send();
      } catch (error) {
        failure = { error };
      }
    })
    .immediate();
  if (failure) throw failure.error;
  return result;
}
