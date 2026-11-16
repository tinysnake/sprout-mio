import { afterAll, describe, expect, it } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contracts from "../src/contracts/delegation";
import type { SproutExtensionAPI } from "../src/extension/types";

type Tool = Parameters<SproutExtensionAPI["registerTool"]>[0];
const directory = mkdtempSync(join(tmpdir(), "delegation-start-"));
process.env.DATABASE_URL = join(directory, "test.sqlite");
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_ENABLED = "false";
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
let gateway: (request: Request) => Promise<Response>;
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await gateway(
      new Request(`${process.env.APP_ORIGIN}/api/remote/agent`, {
        method: "POST",
        headers: {
          authorization: req.headers.authorization ?? "",
          "content-type": "application/json",
        },
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
server.listen(0, "0.0.0.0");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("HTTP address missing");
process.env.APP_ORIGIN = `http://127.0.0.1:${address.port}`;
process.env.PORT = String(address.port);
const { startRuntime, shutdownRuntime, machineRuntimeContext } =
  await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const { createCrewChat } = await import("./fixtures/crew-chat");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const delegations = await import("../src/domain/delegation");
const { setCrewMode } = chats;
const { PiSessionProcess } = await import("../src/server/pi-host/process");
const { issueRemoteToolGrant, revokeRemoteToolGrant, remoteAgentResponse } =
  await import("../src/server/remote-agent-gateway");
const { initializeRequestContext } = await import("../src/server/request-context");
const { createRemoteClient } = await import("../src/extension/remote-client");
const { registerCrewDelegationTools } = await import("../src/extension/crew-delegation-tools");
gateway = (request) => {
  initializeRequestContext(request);
  return remoteAgentResponse(request);
};
const ctx = { userId: "delegation-start-human", requestId: newId(ID_PREFIXES.request) };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, ctx.userId, "start@test.example");
const project = createProject({ name: "Delegation start" }, ctx);
const lead = createAgentProfile({ name: "Lead", persona: "", harness: "pi" }, ctx);
const worker = createAgentProfile({ name: "Worker", persona: "", harness: "pi" }, ctx);
const otherWorker = createAgentProfile({ name: "Other Worker", persona: "", harness: "pi" }, ctx);
const outsider = createAgentProfile({ name: "Outsider", persona: "", harness: "pi" }, ctx);
for (const p of [lead, worker, otherWorker, outsider]) addProjectMember(project.id, p.id, ctx);
function crew() {
  return createCrewChat(
    project.id,
    {
      projectId: project.id,
      title: "Start",
      wakePolicy: "owner_led",
      initialOwner: { kind: "agent", id: lead.id },
      members: [
        { kind: "human", id: ctx.userId },
        { kind: "agent", id: lead.id },
        { kind: "agent", id: worker.id },
        { kind: "agent", id: otherWorker.id },
      ],
    },
    { kind: "human", userId: ctx.userId, ctx },
  );
}
const target = crew();
chats.sendMessage(target.id, { senderKind: "human", senderId: ctx.userId, body: "Start" }, ctx);
const leadRun = runs.listAgentRuns(target.id, ctx)[0]!;
const runnerPath = join(directory, "transport.mjs");
writeFileSync(
  runnerPath,
  `import {createInterface} from 'node:readline';\ncreateInterface({input:process.stdin}).on('line', line => {if(JSON.parse(line).type==='close')process.exit(0)});\n`,
);
const processHandle = new PiSessionProcess(leadRun.id, runnerPath);
const runtime = { ...(await machineRuntimeContext()), requestId: ctx.requestId };
const grant = issueRemoteToolGrant(leadRun.id, processHandle, runtime);
function markRunning(run: ReturnType<typeof runs.listAgentRuns>[number], profile = worker) {
  return runs.transitionAgentRun(
    run.id,
    "running",
    {
      configSnapshot: {
        provider: "transport-test",
        model: "none",
        thinking: "off",
        tools: [],
        extensions: [],
        sessionId: run.sessionId,
        sessionFile: join(directory, `${run.id}.jsonl`),
        cwd: directory,
        sdkVersion: "test",
        profile: {
          id: profile.id,
          name: profile.name,
          persona: "",
          harness: "pi",
          updatedAt: profile.updatedAt,
        },
      },
    },
    ctx,
  );
}
function completeRun(run: ReturnType<typeof runs.listAgentRuns>[number]) {
  const messageId = newId(ID_PREFIXES.message);
  sqlite
    .prepare(
      "INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES (?,?,'agent',?,'Done')",
    )
    .run(messageId, run.chatId, worker.id);
  runs.transitionAgentRun(
    run.id,
    "completed",
    { stopReason: "stop", assistantMessageId: messageId },
    ctx,
  );
}
markRunning(leadRun, lead);
function tool(timeoutMs = 15000, runId = leadRun.id) {
  const tools: Tool[] = [];
  registerCrewDelegationTools(
    {
      registerTool: (definition) => {
        tools.push(definition);
      },
    },
    createRemoteClient(grant, { runId, timeoutMs }),
  );
  return tools.find((definition) => definition.name === "sprout_delegation_start")!;
}
const start = tool();
const count = (chatId = target.id) =>
  sqlite
    .prepare("SELECT count(*) AS n FROM delegation WHERE parent_crew_chat_id=?")
    .get(chatId) as { n: number };
const latest = () =>
  sqlite
    .prepare("SELECT * FROM delegation WHERE parent_crew_chat_id=? ORDER BY rowid DESC LIMIT 1")
    .get(target.id) as { id: string; child_chat_id: string };
function dispatch(request: string) {
  const chat = crew();
  return delegations.dispatchDelegation(
    { chatId: chat.id, workerProfileId: worker.id, request, clientRequestId: request },
    ctx,
  );
}
const childRun = (chatId: string) => runs.listAgentRuns(chatId, ctx)[0]!;
const execute = (request: string, extra: Record<string, unknown> = {}, definition = start) =>
  definition.execute("tool-call", { workerProfileId: worker.id, request, ...extra });
function outcome(result: Awaited<ReturnType<Tool["execute"]>>) {
  expect(result.isError).not.toBe(true);
  return (result.details as { ok: true; data: contracts.DelegationStartOutcome }).data;
}
afterAll(async () => {
  revokeRemoteToolGrant(leadRun.id, {
    ...(await machineRuntimeContext()),
    requestId: ctx.requestId,
  });
  await processHandle.close();
  await shutdownRuntime("delegation-start-test-cleanup");
  server.close();
  await once(server, "close");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("delegation start contract", () => {
  it("clamps the default, zero, negative, fractional and maximum budgets for both input surfaces", () => {
    for (const [value, expected] of [
      [undefined, 10000],
      [0, 0],
      [-1, 0],
      [1.9, 1],
      [60000, 60000],
      [900000, 60000],
    ] as const) {
      const input = {
        workerProfileId: worker.id,
        request: "work",
        ...(value === undefined ? {} : { blockMs: value }),
      };
      expect(
        contracts.crewDelegationToolInputSchemas.sprout_delegation_start.parse(input).blockMs,
      ).toBe(expected);
      const parsed = contracts.crewMutateInputSchema.parse({
        projectId: project.id,
        action: "dispatch",
        ...input,
        clientRequestId: "contract-key",
      });
      expect(parsed.action === "dispatch" && parsed.blockMs).toBe(expected);
    }
  });
  it("validates every outcome and rejects optimistic running without a real run timestamp", () => {
    const base = {
      delegationId: newId(ID_PREFIXES.delegation),
      childChatId: newId(ID_PREFIXES.chat),
      workerName: "Worker",
      runId: newId(ID_PREFIXES.run),
    };
    for (const value of [
      { ...base, outcome: "running", startedAt: new Date().toISOString() },
      ...["queued", "blocked", "failed", "canceled", "timed_out"].map((outcome) => ({
        ...base,
        outcome,
        reason: "reason",
      })),
    ])
      expect(contracts.delegationStartOutcomeSchema.safeParse(value).success).toBe(true);
    for (const value of [
      { ...base, outcome: "running" },
      { ...base, outcome: "failed" },
      { ...base, outcome: "made_up" },
    ]) {
      expect(contracts.delegationStartOutcomeSchema.safeParse(value).success).toBe(false);
      expect(
        contracts.crewMutateResponseSchema.safeParse({
          projectId: project.id,
          chatId: target.id,
          ...value,
        }).success,
      ).toBe(false);
    }
  });
});

describe("dispatch through extension, HTTP gateway and SQLite", () => {
  it("returns queued for blockMs=0 even though delegation.status is optimistically running", async () => {
    const result = outcome(await execute("queued", { blockMs: 0 }));
    expect(result.outcome).toBe("queued");
    expect(result.workerName).toBe(worker.name);
    expect(childRun(result.childChatId).status).toBe("queued");
    expect(result.runId).toBe(childRun(result.childChatId).id);
    expect(
      (
        sqlite.prepare("SELECT status FROM delegation WHERE id=?").get(result.delegationId) as {
          status: string;
        }
      ).status,
    ).toBe("running");
  });
  it("waits outside the transaction until agent_run really starts", async () => {
    const previous = count().n;
    let outsideTransaction = false;
    const timer = setInterval(() => {
      if (count().n <= previous) return;
      const run = childRun(latest().child_chat_id);
      if (run.status !== "queued") return;
      outsideTransaction = !sqlite.inTransaction;
      markRunning(run);
    }, 5);
    try {
      const result = outcome(await execute("running", { blockMs: 500 }));
      expect(result.outcome).toBe("running");
      expect(outsideTransaction).toBe(true);
      expect(result).toMatchObject({
        runId: childRun(result.childChatId).id,
        startedAt: childRun(result.childChatId).startedAt,
      });
    } finally {
      clearInterval(timer);
    }
  });
  it("returns timed_out and replays the same implicit intent without creating a second worker", async () => {
    const before = count().n;
    const first = await execute("retry after timeout", { blockMs: 15 });
    const second = await execute("retry after timeout", { blockMs: 15 });
    expect(count().n - before).toBe(1);
    const a = outcome(first),
      b = outcome(second);
    expect(a.outcome).toBe("timed_out");
    expect(b).toEqual(a);
    expect(childRun(a.childChatId).status).toBe("queued");
  });
  it("treats a changed request, member or lead run as a new intent", async () => {
    const before = count().n;
    const a = outcome(await execute("intent A", { blockMs: 0 }));
    const b = outcome(await execute("intent B", { blockMs: 0 }));
    const c = outcome(
      await execute("intent A", { blockMs: 0 }, tool(15000, newId(ID_PREFIXES.run))),
    );
    const d = outcome(await execute("intent A", { blockMs: 0, workerProfileId: otherWorker.id }));
    expect(count().n - before).toBe(4);
    expect(new Set([a.delegationId, b.delegationId, c.delegationId, d.delegationId]).size).toBe(4);
  });
  it("gives an explicit clientRequestId priority over implicit intent", async () => {
    const before = count().n;
    const a = outcome(await execute("explicit A", { clientRequestId: "explicit", blockMs: 0 }));
    const b = outcome(await execute("explicit B", { clientRequestId: "explicit", blockMs: 0 }));
    expect(count().n - before).toBe(1);
    expect(b.delegationId).toBe(a.delegationId);
  });
  it("allows the full block budget before the HTTP transport timeout", async () => {
    const result = outcome(await execute("transport budget", { blockMs: 200 }, tool(100)));
    expect(result.outcome).toBe("timed_out");
  });
  it("keeps invalid membership, self dispatch and stopped Crew as tool errors", async () => {
    for (const workerProfileId of [outsider.id, lead.id]) {
      const result = await execute("invalid", { workerProfileId, blockMs: 0 });
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ outcome: "rejected", status: expect.any(Number) });
    }
    const human = { kind: "human" as const, userId: ctx.userId, ctx };
    setCrewMode(target.id, "stopped", chats.getChat(target.id, ctx).governanceRevision, human);
    try {
      const result = await execute("stopped", { blockMs: 0 });
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ outcome: "rejected", status: expect.any(Number) });
    } finally {
      setCrewMode(target.id, "active", chats.getChat(target.id, ctx).governanceRevision, human);
    }
  });
});

describe("persisted start failures and early settlement", () => {
  it("reports a failed run and its reason without waiting for delegation reconciliation", async () => {
    const sent = dispatch("failed start");
    const run = childRun(sent.childChatId);
    runs.transitionAgentRun(
      run.id,
      "failed",
      { errorCode: "pi_unavailable", errorMessage: "Pi executable missing" },
      ctx,
    );
    const result = await delegations.waitForDelegationStart(sent.delegationId, 500);
    expect(result).toMatchObject({
      outcome: "failed",
      runId: run.id,
      reason: "Pi executable missing",
    });
  });
  it("reports canceled runs and blocked delegation reasons", async () => {
    const canceled = dispatch("canceled start");
    runs.transitionAgentRun(
      childRun(canceled.childChatId).id,
      "aborted",
      { stopReason: "Canceled by Human" },
      ctx,
    );
    expect(await delegations.waitForDelegationStart(canceled.delegationId, 500)).toMatchObject({
      outcome: "canceled",
      reason: "Canceled by Human",
    });
    const blocked = dispatch("blocked start");
    delegations.blockDelegation(
      blocked.delegationId,
      { reason: "needs_input", summary: "Need a decision" },
      {
        ...ctx,
        agent: {
          agentProfileId: worker.id,
          instanceId: childRun(blocked.childChatId).instanceId,
          runId: childRun(blocked.childChatId).id,
        },
      },
    );
    expect(await delegations.waitForDelegationStart(blocked.delegationId, 500)).toMatchObject({
      outcome: "blocked",
      reason: "Need a decision",
    });
  });
  it.each([0, 15])(
    "retains the launched run after added input queues another run (budget %i)",
    async (blockMs) => {
      const sent = dispatch("completed before extra input");
      const run = childRun(sent.childChatId);
      const started = markRunning(run);
      completeRun(run);
      // queuedAt has second precision; keep the later run deterministic across random IDs.
      sqlite.prepare("UPDATE agent_run SET queued_at=1 WHERE id=?").run(run.id);
      delegations.sendDelegationInput(sent.delegationId, "Follow up", ctx);
      const queued = runs.listAgentRuns(sent.childChatId, ctx).find((item) => item.id !== run.id)!;
      expect(queued.status).toBe("queued");
      expect(await delegations.waitForDelegationStart(sent.delegationId, blockMs)).toMatchObject({
        outcome: "running",
        runId: run.id,
        startedAt: started.startedAt,
      });
    },
  );
  it("retains launch evidence when a fast completion queues follow-up input during the wait", async () => {
    const sent = dispatch("fast completion with follow-up");
    const run = childRun(sent.childChatId);
    const waiting = delegations.waitForDelegationStart(sent.delegationId, 500);
    const started = markRunning(run);
    completeRun(run);
    sqlite.prepare("UPDATE agent_run SET queued_at=1 WHERE id=?").run(run.id);
    delegations.sendDelegationInput(sent.delegationId, "Follow up inside wait", ctx);
    expect(runs.listAgentRuns(sent.childChatId, ctx).some((item) => item.status === "queued")).toBe(
      true,
    );
    expect(await waiting).toMatchObject({
      outcome: "running",
      runId: run.id,
      startedAt: started.startedAt,
    });
  });
  it.each(["failed", "aborted"] as const)(
    "does not let a later %s run override a successful launch",
    async (status) => {
      const sent = dispatch(`later ${status}`);
      const run = childRun(sent.childChatId);
      markRunning(run);
      completeRun(run);
      sqlite.prepare("UPDATE agent_run SET queued_at=1 WHERE id=?").run(run.id);
      delegations.sendDelegationInput(sent.delegationId, "Later wake", ctx);
      const followUp = runs
        .listAgentRuns(sent.childChatId, ctx)
        .find((item) => item.id !== run.id)!;
      runs.transitionAgentRun(
        followUp.id,
        status,
        { errorCode: "host_failure", errorMessage: "Later failure", stopReason: "Later stop" },
        ctx,
      );
      expect(await delegations.waitForDelegationStart(sent.delegationId, 0)).toMatchObject({
        outcome: "running",
        runId: run.id,
      });
    },
  );
  it("reports the original launch failure even when a follow-up run is running", async () => {
    const sent = dispatch("original launch failed");
    const run = childRun(sent.childChatId);
    runs.transitionAgentRun(
      run.id,
      "failed",
      { errorCode: "pi_unavailable", errorMessage: "Original launch failure" },
      ctx,
    );
    sqlite.prepare("UPDATE agent_run SET queued_at=1 WHERE id=?").run(run.id);
    delegations.sendDelegationInput(sent.delegationId, "Try follow-up", ctx);
    const followUp = runs.listAgentRuns(sent.childChatId, ctx).find((item) => item.id !== run.id)!;
    markRunning(followUp);
    expect(await delegations.waitForDelegationStart(sent.delegationId, 0)).toMatchObject({
      outcome: "failed",
      runId: run.id,
      reason: "Original launch failure",
    });
  });
  it.each([
    ["canceled", "failed", "canceled"],
    ["failed", "aborted", "failed"],
    ["blocked", "aborted", "blocked"],
    ["blocked", "failed", "blocked"],
  ] as const)("prioritizes delegation %s over run %s", async (status, runStatus, expected) => {
    const sent = dispatch(`authority ${status} ${runStatus}`);
    const run = childRun(sent.childChatId);
    runs.transitionAgentRun(
      run.id,
      runStatus,
      { errorCode: "host_failure", errorMessage: "Run failure", stopReason: "Run stop" },
      ctx,
    );
    sqlite
      .prepare(
        "UPDATE delegation SET status=?, terminal_summary=?, terminal_reason=?, settled_at=? WHERE id=?",
      )
      .run(
        status,
        "Authoritative delegation reason",
        status === "blocked" ? null : status,
        status === "blocked" ? null : Math.floor(Date.now() / 1000),
        sent.delegationId,
      );
    expect(await delegations.waitForDelegationStart(sent.delegationId, 0)).toMatchObject({
      outcome: expected,
      reason: "Authoritative delegation reason",
    });
  });
  it("retains real startedAt when a fast worker finishes inside the wait window", async () => {
    const sent = dispatch("fast completion");
    const run = childRun(sent.childChatId);
    markRunning(run);
    const messageId = newId(ID_PREFIXES.message);
    sqlite
      .prepare(
        "INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES (?,?,'agent',?,'Done')",
      )
      .run(messageId, sent.childChatId, worker.id);
    runs.transitionAgentRun(
      run.id,
      "completed",
      { stopReason: "stop", assistantMessageId: messageId },
      ctx,
    );
    expect(await delegations.waitForDelegationStart(sent.delegationId, 500)).toMatchObject({
      outcome: "running",
      startedAt: childRun(sent.childChatId).startedAt,
    });
  });
});
