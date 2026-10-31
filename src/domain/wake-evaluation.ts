import { createHash } from "node:crypto";
import {
  WAKE_CONTEXT_LIMITS as limits,
  wakeEvaluationInputSchema,
  wakeEvaluationResultForInputSchema,
  type WakeEvaluationInput,
  type WakeEvaluationResult,
  type WakeEvaluationErrorCode,
  type WakeRecipientDecision,
  type WakeProvider,
} from "../contracts/wake-evaluation";
import { routeWakeCandidates } from "./chat-wake";

export type WakeCandidateSnapshot = WakeEvaluationInput["candidates"][number];
type Message = WakeEvaluationInput["recentMessages"][number];
type Task = WakeEvaluationInput["tasks"][number];
export type WakeSnapshotFacts = Omit<
  WakeEvaluationInput,
  | "evaluatedAt"
  | "snapshotHash"
  | "truncation"
  | "recentMessages"
  | "triggerMessage"
  | "candidates"
  | "tasks"
> & {
  readonly archived: boolean;
  readonly recentMessages: readonly Message[];
  readonly triggerMessage: Message | null;
  readonly members: readonly {
    readonly candidate: WakeCandidateSnapshot;
    readonly profileName: string;
    readonly projectMember: boolean;
    readonly effectiveMember: boolean;
  }[];
  readonly tasks: readonly (Omit<Task, "status"> & {
    readonly status: "proposed" | "assigned" | "finished" | "canceled";
  })[];
};
export type PreparedWakeEvaluation =
  | { kind: "model"; input: WakeEvaluationInput }
  | { kind: "rule"; input: WakeEvaluationInput; result: WakeEvaluationResult }
  | { kind: "skipped"; reasonCode: string }
  | { kind: "failed"; result: WakeEvaluationResult };

export type WakeUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  inputCharacters: number;
  durationMs: number;
  /** The version a rolling model tag resolved to, when the provider reports one. */
  resolvedModel?: string | null;
};
export type WakeReceipt = { result: WakeEvaluationResult; usage: WakeUsage };
export type WakeJudge = (input: WakeEvaluationInput) => Promise<WakeReceipt>;

const size = (value: string) => Array.from(value).length;
const clip = (value: string, length: number) => Array.from(value).slice(0, length).join("");
export const recipientKey = (value: WakeCandidateSnapshot["recipient"]) =>
  `${value.kind}:${value.id}`;

export function failedWakeResult(
  input: Pick<WakeEvaluationInput, "policy" | "snapshotHash">,
  code: WakeEvaluationErrorCode,
  reason: string,
): WakeEvaluationResult {
  return {
    decision: "indeterminate",
    reason,
    reasonCode: code === "provider_unavailable" ? "wake_provider_unavailable" : code,
    recipients: [],
    selectedRecipients: [],
    probability: null,
    provider: input.policy.provider,
    model: input.policy.model,
    version: input.policy.thresholdVersion,
    snapshotHash: input.snapshotHash,
    errorCode: code,
  };
}

export function decidedWakeResult(
  input: WakeEvaluationInput,
  recipients: WakeRecipientDecision[],
  reasonCode: string,
): WakeEvaluationResult {
  const selectedRecipients = recipients
    .filter((item) => item.decision === "yes")
    .map((x) => x.recipient);
  const uncertain = recipients.some((item) => item.decision === "unknown");
  return wakeEvaluationResultForInputSchema(input).parse({
    decision: selectedRecipients.length
      ? "continue"
      : uncertain
        ? "indeterminate"
        : "do_not_continue",
    reason: uncertain ? "存在不确定候选，仅明确需要行动者可接续" : "已逐一判定全部候选",
    reasonCode,
    recipients,
    selectedRecipients,
    probability: null,
    provider: input.policy.provider,
    model: input.policy.model,
    version: input.policy.thresholdVersion,
    snapshotHash: input.snapshotHash,
    errorCode: uncertain ? "provider_low_certainty" : null,
  });
}

/** Caller supplies database facts, including current membership and existing instance IDs. */
export function prepareWakeEvaluation(facts: WakeSnapshotFacts, now: Date): PreparedWakeEvaluation {
  if (facts.archived) return { kind: "skipped", reasonCode: "chat_archived" };
  const tasks = facts.tasks
    .filter((task) => task.status === "assigned" && task.chatId === facts.chatId)
    .map((task) => {
      const title = clip(task.title, 120);
      const lastRecord = task.lastRecord
        ? {
            ...task.lastRecord,
            body: clip(task.lastRecord.body, limits.taskCharacters - size(title)),
            truncated:
              task.lastRecord.truncated ||
              size(task.lastRecord.body) > limits.taskCharacters - size(title),
          }
        : null;
      return { ...task, status: "assigned" as const, title, lastRecord };
    });
  if (facts.source === "task_periodic" && !tasks.length)
    return { kind: "skipped", reasonCode: "no_assigned_task" };

  const members = facts.members.filter(
    (member) =>
      member.projectMember && member.effectiveMember && member.candidate.recipient.kind === "agent",
  );
  const sender = facts.triggerMessage?.sender;
  let candidates = members
    .filter((member) => sender?.kind !== "agent" || sender.id !== member.candidate.recipient.id)
    .map((member) => member.candidate);
  let rule = facts.chat.kind === "dm";
  if (facts.source === "task_periodic") {
    if (facts.chat.kind !== "dm") {
      candidates =
        facts.chat.owner.kind === "human"
          ? [
              {
                recipient: facts.chat.owner,
                instanceId: null,
                personaSummary: "Human owner",
                responsibility: "处理当前 Chat 中需要人类回应的事项",
                activeRun: null,
                latestRun: null,
                externalWork: [],
              },
            ]
          : members
              .filter((m) => recipientKey(m.candidate.recipient) === recipientKey(facts.chat.owner))
              .map((m) => m.candidate);
    }
    rule = false;
  } else if (facts.chat.kind !== "dm") {
    const routed = routeWakeCandidates({
      body: facts.triggerMessage?.body ?? "",
      chat: {
        id: facts.chatId,
        kind: facts.chat.kind,
        wakePolicy: "mention_only",
        ownerKind: facts.chat.owner.kind,
        ownerId: facts.chat.owner.id,
      },
      effectiveMembers: members.map((m) => ({
        memberKind: "agent",
        memberId: m.candidate.recipient.id,
        profileName: m.profileName,
      })),
      senderAgentProfileId: sender?.kind === "agent" ? sender.id : undefined,
    });
    if (routed.length || facts.chat.wakePolicy !== "contextual") {
      const ids = routed.length
        ? routed
        : routeWakeCandidates({
            body: facts.triggerMessage?.body ?? "",
            chat: {
              id: facts.chatId,
              kind: facts.chat.kind,
              wakePolicy: facts.chat.wakePolicy,
              ownerKind: facts.chat.owner.kind,
              ownerId: facts.chat.owner.id,
            },
            effectiveMembers: members.map((m) => ({
              memberKind: "agent",
              memberId: m.candidate.recipient.id,
              profileName: m.profileName,
            })),
            senderAgentProfileId: sender?.kind === "agent" ? sender.id : undefined,
          });
      candidates = candidates.filter((c) => ids.some((id) => id.agentProfileId === c.recipient.id));
      rule = true;
    }
  }
  if (facts.chat.kind === "dm" && candidates.length !== 1)
    return { kind: "skipped", reasonCode: "dm_agent_unavailable" };
  if (!candidates.length) return { kind: "skipped", reasonCode: "no_candidates" };

  const ordered = [...facts.recentMessages].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  let budget: number = limits.recentMessageCharacters;
  const recentMessages: Message[] = [];
  const dropped: Message[] = [];
  for (const item of [...ordered].reverse()) {
    if (recentMessages.length >= limits.recentMessages || budget === 0) {
      dropped.push(item);
      continue;
    }
    const body = clip(item.body, Math.min(limits.messageCharacters, budget));
    budget -= size(body);
    recentMessages.push({
      ...item,
      body,
      truncated: item.truncated || size(body) < size(item.body),
    });
  }
  recentMessages.reverse();
  dropped.reverse();
  const triggerMessage = facts.triggerMessage
    ? {
        ...facts.triggerMessage,
        body: clip(facts.triggerMessage.body, limits.messageCharacters),
        truncated:
          facts.triggerMessage.truncated ||
          size(facts.triggerMessage.body) > limits.messageCharacters,
      }
    : null;
  const snapshot = {
    source: facts.source,
    projectId: facts.projectId,
    chatId: facts.chatId,
    triggerId: facts.triggerId,
    round: facts.round,
    controlEpoch: facts.controlEpoch,
    policy: facts.policy,
    evaluatedAt: now.toISOString(),
    triggerMessage,
    latestReadableMessageId: facts.latestReadableMessageId,
    recentMessages,
    chat: {
      ...facts.chat,
      goal: clip(facts.chat.goal, 1000),
      collaboration: clip(facts.chat.collaboration, 1000),
    },
    candidates: candidates.map((c) => ({
      ...c,
      personaSummary: clip(c.personaSummary, limits.personaCharacters),
      responsibility: clip(c.responsibility, 600),
      externalWork: c.externalWork.map((work) => ({ ...work, summary: clip(work.summary, 600) })),
    })),
    tasks,
    truncation: {
      originalMessageCount: ordered.length,
      includedMessageCount: recentMessages.length,
      droppedMessageIdRange: dropped.length
        ? { first: dropped[0].id, last: dropped[dropped.length - 1].id }
        : null,
      tasksComplete: true as const,
      candidatesComplete: true as const,
      recentMessageCharacters: limits.recentMessageCharacters - budget,
      characterBudget: limits.snapshotCharacters,
    },
    snapshotHash: "0".repeat(64),
  };
  const excess = () => size(JSON.stringify(snapshot)) - limits.snapshotCharacters;
  while (excess() > 0 && recentMessages.length) {
    dropped.push(recentMessages.shift()!);
    snapshot.truncation.includedMessageCount = recentMessages.length;
    snapshot.truncation.recentMessageCharacters = recentMessages.reduce(
      (sum, message) => sum + size(message.body),
      0,
    );
    snapshot.truncation.droppedMessageIdRange = {
      first: dropped[0].id,
      last: dropped[dropped.length - 1].id,
    };
  }
  for (const candidate of snapshot.candidates) {
    if (excess() <= 0) break;
    candidate.personaSummary = clip(
      candidate.personaSummary,
      Math.max(0, size(candidate.personaSummary) - excess()),
    );
  }
  for (const task of snapshot.tasks) {
    if (excess() <= 0) break;
    if (task.lastRecord) {
      const body = clip(task.lastRecord.body, Math.max(0, size(task.lastRecord.body) - excess()));
      task.lastRecord.truncated ||= body !== task.lastRecord.body;
      task.lastRecord.body = body;
    }
  }
  snapshot.snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  if (excess() > 0)
    return {
      kind: "failed",
      result: failedWakeResult(
        snapshot,
        "context_budget_exceeded",
        "完整候选和任务快照超出 24000 字符预算",
      ),
    };
  const input = wakeEvaluationInputSchema.parse(snapshot);
  return rule
    ? {
        kind: "rule",
        input,
        result: decidedWakeResult(
          input,
          input.candidates.map((c) => ({
            recipient: c.recipient,
            decision: "yes",
            reason: "既有 DM、点名或 owner 规则",
            probability: null,
          })),
          "explicit_rule",
        ),
      }
    : { kind: "model", input };
}

/** Dispatch exactly once to the configured provider; judges receive no database/tool capability. */
export async function evaluateWake(
  input: WakeEvaluationInput,
  judges: Record<WakeProvider, WakeJudge>,
): Promise<WakeReceipt> {
  const parsed = wakeEvaluationInputSchema.parse(input);
  try {
    const receipt = await judges[parsed.policy.provider](parsed);
    return { ...receipt, result: wakeEvaluationResultForInputSchema(parsed).parse(receipt.result) };
  } catch {
    return {
      result: failedWakeResult(parsed, "internal_failure", "所选判定器未能完成请求"),
      usage: {
        inputTokens: null,
        outputTokens: null,
        inputCharacters: size(JSON.stringify(parsed)),
        durationMs: 0,
      },
    };
  }
}
