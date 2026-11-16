import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const probe = `
import {sqlite} from './src/db/index.ts';
import {listCrewDelegations} from './src/domain/delegation.ts';
import {listAgentRuns} from './src/domain/agent-run.ts';
import {listMessages} from './src/domain/chat.ts';
const {chatId,projectId,userId}=JSON.parse(process.env.AB_PROBE);
const ctx={userId,projectId,requestId:'req_ab_probe'};
try {
 const crew=listCrewDelegations(chatId,ctx);
 const chatIds=[chatId,...crew.delegations.map(d=>d.childChatId)];
 console.log(JSON.stringify({...crew,runs:chatIds.flatMap(id=>listAgentRuns(id,ctx)),messages:listMessages(chatId,ctx)}));
} finally {sqlite.close()}
`;
export function readEvidence(env, input, timeoutMs = 30000) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probe],
    {
      cwd: process.cwd(),
      env: { ...env, AB_PROBE: JSON.stringify(input) },
      encoding: "utf8",
      timeout: timeoutMs,
    },
  );
  if (result.status !== 0)
    throw new Error(`domain evidence probe failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
export function systemPromptEvidence(request) {
  const system = request.messages.filter((message) =>
    ["system", "developer"].includes(message.role),
  );
  if (!system.length) return null;
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    const firstLine = content.split("\n")[0];
    if (!firstLine.startsWith('{"channel":"sprout_turn_context"')) continue;
    const context = JSON.parse(firstLine);
    if (!context.runId) return null;
    return {
      runId: context.runId,
      model: request.model,
      hash: createHash("sha256").update(JSON.stringify(system)).digest("hex"),
    };
  }
  return null;
}

export function settled(e) {
  return (
    e.runs.length > 0 &&
    e.runs.every((r) => !["queued", "running"].includes(r.status)) &&
    e.delegations.every((d) => !["pending", "running", "queued", "canceling"].includes(d.status)) &&
    e.events.every((event) => !["pending", "bound", "injected"].includes(event.deliveryState))
  );
}
export function assistantMessagesByRun(entries) {
  const byRun = new Map();
  let runId;
  for (const entry of entries) {
    if (entry.message?.role === "user") {
      const content = entry.message.content;
      const text =
        typeof content === "string"
          ? content
          : (content ?? [])
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("");
      const firstLine = text.split("\n")[0];
      if (firstLine.startsWith('{"channel":"sprout_turn_context"')) {
        const context = JSON.parse(firstLine);
        if (!context.runId) throw new Error("turn context has no runId");
        runId = context.runId;
      }
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      if (!runId) throw new Error("assistant transcript has no persisted run binding");
      const messages = byRun.get(runId) ?? [];
      messages.push(entry);
      byRun.set(runId, messages);
    }
  }
  return byRun;
}
export function factsFrom(e, chatId, artifactFiles = []) {
  const perWorker = {};
  for (const d of e.delegations)
    perWorker[d.workerProfileId] = (perWorker[d.workerProfileId] ?? 0) + 1;
  const workerRuns = e.runs.filter((r) => r.chatId !== chatId);
  const sessions = new Map();
  for (const r of e.runs) {
    const file = r.configSnapshot?.sessionFile;
    if (!file) continue;
    if (!existsSync(file)) throw new Error(`missing real transcript ${file}`);
    if (!sessions.has(file))
      sessions.set(
        file,
        assistantMessagesByRun(
          readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        ),
      );
  }
  const observations = e.runs.map((r) => {
    const messages = sessions.get(r.configSnapshot?.sessionFile)?.get(r.id) ?? [];
    const tools = messages
      .flatMap((x) => x.message.content ?? [])
      .filter((x) => x.type === "toolCall");
    const usage = messages.map((x) => x.message.usage).filter(Boolean);
    const tokens = usage.length
      ? usage.reduce(
          (sum, u) =>
            sum +
            (u.totalTokens ??
              (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)),
          0,
        )
      : null;
    return {
      runId: r.id,
      profileId: r.configSnapshot?.profile.id ?? null,
      chatId: r.chatId,
      startedAt: r.startedAt ?? null,
      settledAt: r.settledAt ?? null,
      status: r.status,
      provider: r.configSnapshot?.provider ?? null,
      model: r.configSnapshot?.model ?? null,
      sdkVersion: r.configSnapshot?.sdkVersion ?? null,
      transcript: r.configSnapshot?.sessionFile ?? null,
      readySnapshot: r.configSnapshot
        ? {
            resources: r.configSnapshot.resources ?? null,
            tools: r.configSnapshot.tools ?? null,
          }
        : null,
      role: r.chatId === chatId ? "lead" : "worker",
      systemPromptChars: r.configSnapshot?.resources?.systemPromptChars ?? null,
      availableTools: r.configSnapshot?.tools ?? null,
      inheritHostResources: r.configSnapshot?.resources?.inheritHostResources ?? null,
      cwd: r.configSnapshot?.cwd ?? null,
      finalReplyText: (
        messages.findLast((x) => x.message.stopReason === "stop")?.message.content ?? []
      )
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      tools: tools.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })),
      usage,
      tokens,
      finalReplyAtMs:
        messages
          .filter(
            (x) =>
              x.message.stopReason === "stop" &&
              x.message.content?.some((c) => c.type === "text" && c.text.trim()),
          )
          .map((x) => Date.parse(x.timestamp))
          .at(-1) ?? null,
    };
  });
  const workerEvidence = observations.filter((r) => r.chatId !== chatId);
  if (
    workerRuns.some((r) => r.status === "completed") &&
    workerEvidence.some((r) => !r.startedAt || r.tokens === null || !r.transcript)
  )
    throw new Error("completed worker has no real startup/token/transcript evidence");
  const completeEvents = e.events.filter((event) => event.kind === "completed");
  const leadFinal = observations
    .filter(
      (r) =>
        r.chatId === chatId &&
        r.status === "completed" &&
        e.runs.find((run) => run.id === r.runId)?.assistantMessageId,
    )
    .map((r) => r.finalReplyAtMs)
    .filter((t) => t !== null);
  const finalReplies = observations.filter(
    (r) =>
      r.chatId === chatId &&
      r.status === "completed" &&
      e.runs.find((run) => run.id === r.runId)?.assistantMessageId &&
      r.finalReplyAtMs !== null,
  );
  const delegationsPerArtifact = {};
  const dispatches = observations
    .filter((r) => r.role === "lead")
    .flatMap((r) => r.tools)
    .filter((t) => t.name === "sprout_delegation_start");
  for (const delegation of e.delegations) {
    const dispatch = dispatches.find(
      (call) =>
        call.arguments.request === delegation.requestSummary &&
        call.arguments.workerProfileId === delegation.workerProfileId,
    );
    const assignment = JSON.stringify({
      request: delegation.requestSummary,
      resources: dispatch?.arguments.resources,
    });
    for (const file of artifactFiles) {
      // A directory scope hands every fixture artifact under it to that member.
      const directory = file.slice(0, file.lastIndexOf("/") + 1);
      if (
        assignment.includes(file) ||
        (directory && assignment.includes(`"${directory.replace(/\/$/, "")}"`))
      )
        delegationsPerArtifact[file] = (delegationsPerArtifact[file] ?? 0) + 1;
    }
  }
  return {
    delegatedCount: e.delegations.length,
    delegationsPerArtifact,
    leadFinalReplyText:
      finalReplies.sort((a, b) => a.finalReplyAtMs - b.finalReplyAtMs).at(-1)?.finalReplyText ?? "",
    workerFindings: workerEvidence.map((r) =>
      [
        r.finalReplyText,
        ...r.tools
          .filter((t) => t.name === "sprout_delegation_complete")
          .map((t) => t.arguments.summary ?? ""),
      ].join("\n"),
    ),
    distinctWorkerProfiles: Object.keys(perWorker),
    delegationsPerWorker: perWorker,
    workerRunTerminalStatuses: workerRuns.map((r) => r.status),
    workerReportedComplete: e.delegations.map(
      (d) =>
        completeEvents.some((event) => event.delegationId === d.id) &&
        workerEvidence
          .filter((r) => r.chatId === d.childChatId)
          .some((r) => r.tools.some((t) => t.name === "sprout_delegation_complete")),
    ),
    workerBlocked: e.delegations
      .filter((d) => d.status === "blocked")
      .map((d) => ({ id: d.id, reason: d.terminalReason, summary: d.terminalSummary })),
    completeEventTimes: completeEvents.map((event) => event.createdAt),
    leadFinalReplyAtMs: leadFinal.length ? Math.max(...leadFinal) : null,
    firstDelegationTerminalAtMs: e.delegations.length
      ? Math.min(...e.delegations.map((d) => d.settledAt ?? Infinity))
      : null,
    artifactAssertions: null,
    workerRuns: workerEvidence,
    runs: observations,
    token: observations.every((r) => r.tokens !== null)
      ? observations.reduce((sum, r) => sum + r.tokens, 0)
      : null,
  };
}
