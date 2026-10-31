import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  prepareWakeEvaluation,
  recipientKey,
  type WakeSnapshotFacts,
} from "../../../src/domain/wake-evaluation";

type Sample = {
  id: string;
  scene: string;
  chatKind: "group" | "public_channel";
  members: { kind: "human" | "agent"; name: string; role: string; responsibilities?: string }[];
  owner: { kind: "human" | "agent"; name: string };
  task: { status: "assigned" | "finished"; title: string } | null;
  messages: { senderKind: "human" | "agent"; senderName: string; body: string }[];
  trigger: { kind: string; body?: string };
  covers: string[];
};
const source = process.argv[2];
if (!source) throw new Error("Pass orchestrate/sprout-mio-p6/samples/wake-samples.json");
const raw = readFileSync(source, "utf8");
const samples = JSON.parse(raw) as Sample[];
const stableId = (prefix: string, value: string) => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const now = new Date("2026-01-01T00:00:00.000Z");
const definitions = [
  { id: "w01", selected: "none" },
  { id: "w06", selected: "all" },
  { id: "w12", selected: "owner" },
  { id: "w13", selected: "owner" },
  { id: "w17", selected: "none" },
  { id: "w20", selected: "owner", periodic: true },
  { id: "w22", selected: "all" },
  { id: "w23", selected: "none" },
  { id: "w24", selected: "none" },
  { id: "w25", selected: "none" },
];
const cases = definitions.map((definition) => {
  const sample = samples.find((s) => s.id === definition.id)!;
  const identity = (kind: "agent" | "human", name: string) => ({
    kind,
    id: `${kind}_${sample.members.findIndex((m) => m.kind === kind && m.name === name)}`,
  });
  const owner = identity(sample.owner.kind, sample.owner.name);
  const recentMessages = sample.messages.map((message, index) => ({
    id: stableId("msg", `${sample.id}_${index}`),
    kind: message.senderKind,
    sender: identity(message.senderKind, message.senderName),
    body: message.body,
    createdAt: new Date(now.getTime() - (sample.messages.length - index) * 1000).toISOString(),
    truncated: false,
  }));
  const periodic = definition.periodic || sample.trigger.kind === "periodic_check";
  const triggerMessage = periodic
    ? null
    : { ...recentMessages[recentMessages.length - 1], body: sample.trigger.body! };
  const facts: WakeSnapshotFacts = {
    source: periodic ? "task_periodic" : "message",
    projectId: stableId("prj", "project"),
    chatId: stableId("cnv", "chat"),
    triggerId: triggerMessage?.id ?? `periodic_${sample.id}`,
    round: 1,
    controlEpoch: 1,
    policy: {
      provider: "small_brain",
      configRevision: 1,
      model: "fixture/model",
      thresholdVersion: "fixture-v1",
    },
    archived: false,
    triggerMessage,
    latestReadableMessageId: recentMessages.at(-1)?.id ?? null,
    recentMessages,
    chat: {
      kind: sample.chatKind,
      goal: sample.scene,
      collaboration: "按职责协作；确认、等待和收尾无需回复",
      owner,
      wakePolicy: "contextual",
      governanceRevision: 1,
    },
    members: sample.members
      .filter((m) => m.kind === "agent")
      .map((member, index) => ({
        candidate: {
          recipient: identity("agent", member.name),
          instanceId: stableId("ins", `${sample.id}_${index}`),
          personaSummary: `${member.name}（${member.role}）`,
          responsibility: member.responsibilities ?? member.role,
          activeRun:
            sample.id === "w13" && member.name === sample.owner.name
              ? {
                  id: stableId("run", "working"),
                  status: "running",
                  updatedAt: now.toISOString(),
                  pendingInputs: 0,
                  attemptedInputs: 1,
                }
              : null,
          latestRun: null,
          externalWork: [],
        },
        profileName: member.name,
        projectMember: true,
        effectiveMember: true,
      })),
    tasks: sample.task
      ? [
          {
            id: stableId("tsk", sample.id),
            title: sample.task.title,
            status: sample.task.status,
            revision: 1,
            assignmentRevision: 1,
            chatId: stableId("cnv", "chat"),
            responsibility: owner,
            checklistTotal: 1,
            checklistChecked: 0,
            recordCount: 0,
            lastRecord: null,
            previousCompletionRef: null,
          },
        ]
      : [],
  };
  const prepared = prepareWakeEvaluation(facts, now);
  if (prepared.kind === "failed") throw new Error(JSON.stringify(prepared));
  const input = prepared.kind === "skipped" ? null : prepared.input;
  const selected =
    definition.selected === "none"
      ? []
      : input!.candidates
          .filter(
            (candidate) =>
              definition.selected === "all" ||
              recipientKey(candidate.recipient) === recipientKey(owner),
          )
          .map((candidate) => recipientKey(candidate.recipient));
  return {
    id: sample.id,
    source: {
      path: "orchestrate/sprout-mio-p6/samples/wake-samples.json",
      id: sample.id,
      sha256: createHash("sha256").update(raw).digest("hex"),
      adaptation: definition.periodic
        ? "Human owner 提醒改为设计 §1 的周期 owner 判定；原文保留在最近消息"
        : "使用 trigger.body；成员身份转换为稳定 fixture id；仅 assigned Task 进入快照",
    },
    covers: sample.covers,
    now: now.toISOString(),
    facts,
    input,
    expected: {
      preparation: prepared.kind,
      candidates: input?.candidates.map((c) => recipientKey(c.recipient)) ?? [],
      selected,
      sideEffects: { runs: 0, messages: 0, inputs: 0 },
      providerCalls: prepared.kind === "model" ? 1 : 0,
    },
  };
});
writeFileSync(new URL("./zh-wake.json", import.meta.url), JSON.stringify(cases, null, 2) + "\n");
