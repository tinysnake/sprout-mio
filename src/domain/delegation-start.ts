import { and, eq, sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import { clampDelegationStartBlockMs, type DelegationStartOutcome } from "../contracts/delegation";
import { db } from "../db";
import { agentProfile, agentRun, delegation } from "../db/schema";

function readStart(delegationId: string): DelegationStartOutcome {
  const row = db.select().from(delegation).where(eq(delegation.id, delegationId)).get();
  if (!row) throw new Error("Dispatched delegation missing");
  const worker = db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.id, row.workerProfileId))
    .get();
  const run = db
    .select()
    .from(agentRun)
    .where(
      and(
        eq(agentRun.chatId, row.childChatId),
        ...(row.workerInstanceId ? [eq(agentRun.instanceId, row.workerInstanceId)] : []),
      ),
    )
    // Observe the dispatch's first run, not later input/continuation wakes.
    // queuedAt has second precision and IDs are random; rowid preserves insertion order.
    .orderBy(sql`${agentRun}.rowid asc`)
    .get();
  // dispatchDelegation commits the child chat and its first run atomically.
  if (!worker || !run) throw new Error("Dispatched worker run missing");
  const identity = {
    delegationId: row.id,
    childChatId: row.childChatId,
    workerName: worker.name,
    runId: run.id,
  };
  if (row.status === "canceled" || row.status === "canceling")
    return {
      ...identity,
      outcome: "canceled",
      reason: row.terminalSummary ?? run.stopReason ?? "Delegation canceled",
    };
  if (row.status === "failed")
    return {
      ...identity,
      outcome: "failed",
      reason:
        row.terminalSummary ??
        run.errorMessage ??
        run.errorCode ??
        run.stopReason ??
        "Worker run interrupted",
    };
  if (row.status === "blocked")
    return { ...identity, outcome: "blocked", reason: row.terminalSummary ?? "Worker is blocked" };
  // Supplement an unsettled delegation with host-side failure of its original launch only.
  if (row.status === "queued" || row.status === "running") {
    if (run.status === "aborted")
      return { ...identity, outcome: "canceled", reason: run.stopReason ?? "Delegation canceled" };
    if (run.status === "failed" || run.status === "interrupted")
      return {
        ...identity,
        outcome: "failed",
        reason: run.errorMessage ?? run.errorCode ?? run.stopReason ?? "Worker run interrupted",
      };
  }
  // A fast worker may already be completed; its real startedAt still proves launch.
  // delegation.status/startedAt are optimistic dispatch values, never launch evidence.
  if ((run.status === "running" || run.status === "completed") && run.startedAt)
    return { ...identity, outcome: "running", startedAt: run.startedAt.toISOString() };
  return {
    ...identity,
    outcome: "queued",
    reason: "Worker run is queued; the host has not started it",
  };
}

/** Observe a committed dispatch. Never hold a SQLite transaction across the wait. */
export async function waitForDelegationStart(
  delegationId: string,
  requestedBlockMs?: number,
): Promise<DelegationStartOutcome> {
  const blockMs = clampDelegationStartBlockMs(requestedBlockMs);
  const deadline = performance.now() + blockMs;
  for (;;) {
    const snapshot = readStart(delegationId);
    if (snapshot.outcome !== "queued" || blockMs === 0) return snapshot;
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      return {
        ...snapshot,
        outcome: "timed_out",
        reason: "Start wait budget exhausted; delegation is dispatched and remains queued",
      };
    await delay(Math.min(250, remaining));
  }
}
