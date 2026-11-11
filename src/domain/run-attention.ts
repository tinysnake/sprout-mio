import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentRun, project } from "../db/schema";
import type { AgentRunStatus } from "../contracts/agent-run";
import {
  resolveRunAttentionPolicy,
  type RunAttentionFacts,
  type RunAttentionPolicy,
} from "../contracts/run-attention";

type AgentRunRow = typeof agentRun.$inferSelect;
export type RunAttentionStepInput = {
  status: AgentRunStatus;
  startedAt: Date | null;
  policy: RunAttentionPolicy;
  owner: "agent" | "human" | "self";
  attentionAt: Date | null;
  humanNotifiedAt: Date | null;
  noticeNextAt: Date | null;
  now: Date;
};
export type RunAttentionStep =
  | "pending"
  | "mark_human_required"
  | "remind_owner"
  | "retry_owner"
  | "notify_human"
  | "done";

export function runAttentionStep(input: RunAttentionStepInput): RunAttentionStep {
  if (input.status !== "running" || !input.startedAt || input.humanNotifiedAt) return "done";
  const deadline = input.startedAt.getTime() + input.policy.timeoutMs;
  if (input.now.getTime() >= deadline + input.policy.escalationMs) return "notify_human";
  if (input.now.getTime() < deadline) return "pending";
  if (!input.attentionAt) return input.owner === "agent" ? "remind_owner" : "mark_human_required";
  if (input.owner === "agent" && input.noticeNextAt && input.now >= input.noticeNextAt) {
    return "retry_owner";
  }
  return "pending";
}

export function projectRunAttentionPolicy(projectId: string): RunAttentionPolicy {
  const row = db
    .select({ wakePolicy: project.wakePolicy })
    .from(project)
    .where(eq(project.id, projectId))
    .get();
  return resolveRunAttentionPolicy(row?.wakePolicy?.runAttention);
}

export function runAttentionFacts(row: AgentRunRow, now: Date): RunAttentionFacts | null {
  if (!row.startedAt || !row.attentionPolicySnapshot) return null;
  const deadline = row.startedAt.getTime() + row.attentionPolicySnapshot.timeoutMs;
  const humanReminder = deadline + row.attentionPolicySnapshot.escalationMs;
  return {
    deadlineAt: new Date(deadline).toISOString(),
    humanReminderAt: new Date(humanReminder).toISOString(),
    attentionAt: row.attentionAt?.toISOString() ?? null,
    humanRequiredAt: row.humanRequiredAt?.toISOString() ?? null,
    humanNotifiedAt: row.humanNotifiedAt?.toISOString() ?? null,
    awaitingHandling:
      row.status === "running" && now.getTime() >= deadline && !!row.humanRequiredAt,
    ownerAutoAttemptsPaused: !!row.humanNotifiedAt,
  };
}
