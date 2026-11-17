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
function completeRun(run: ReturnType<typeof runs.listAgentRuns>[number], profile = worker) {
  const messageId = newId(ID_PREFIXES.message);
  sqlite
    .prepare(
      "INSERT INTO message(id,chat_id,sender_kind,sender_id,body) VALUES (?,?,'agent',?,'Done')",
    )
    .run(messageId, run.chatId, profile.id);
  runs.transitionAgentRun(
    run.id,
    "completed",
    { stopReason: "stop", assistantMessageId: messageId },
    ctx,
  );
}
markRunning(leadRun, lead);
function tool(timeoutMs = 15000, runId = leadRun.id, remoteGrant = grant) {
  const tools: Tool[] = [];
  registerCrewDelegationTools(
    {
      registerTool: (definition) => {
        tools.push(definition);
      },
    },
    createRemoteClient(remoteGrant, { runId, timeoutMs }),
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
  it("preserves the real Crew epoch rejection reason through the gateway and model tool", async () => {
    const { registerRemoteTools } = await import("../src/extension/remote-tools");
    const tools: Tool[] = [];
    registerRemoteTools(
      {
        registerTool: (definition) => {
          tools.push(definition);
        },
      },
      createRemoteClient(grant),
    );
    const response = await tools
      .find((definition) => definition.name === "sprout_resource_request")!
      .execute("stale-crew", {
        crewChatId: target.id,
        crewEpoch: 999,
        subjectKind: "lead_run",
        runId: leadRun.id,
        machineId: "mch_00000000",
        membershipEpoch: 1,
        directoryRealPath: "/workspace",
        directoryRevision: 1,
        operations: ["shell"],
        clientRequestId: "stale-crew-context",
      });
    expect(response.isError).toBe(true);
    expect(response.details).toMatchObject({
      outcome: "rejected",
      status: 403,
      error: { code: "forbidden", message: "crew_epoch_changed" },
    });
    const content = response.content[0]!;
    expect(content.type).toBe("text");
    if (content.type === "text") expect(JSON.parse(content.text)).toEqual(response.details);
  });

  it("publishes resources and passes them through the real gateway into approved Crew requests", async () => {
    const { createMachine, saveProjectMachineBinding } = await import("../src/domain/machine");
    const machineContext = { ...runtime, userId: ctx.userId, now: new Date() };
    const machineId = createMachine({ name: "Delegated resource" }, machineContext).detail.machine
      .id;
    saveProjectMachineBinding(
      { projectId: project.id, machineId, description: "", expectedRevision: null },
      machineContext,
    );
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO project_machine_membership(project_id,machine_id,epoch,state,joined_at) VALUES (?,?,1,'active',1)",
      )
      .run(project.id, machineId);
    sqlite
      .prepare(
        "INSERT INTO machine_connection(machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at) VALUES (?,1,?,?,'open',1,1)",
      )
      .run(machineId, newId(ID_PREFIXES.request), runtime.bootId);
    sqlite
      .prepare(
        "INSERT INTO directory_observation(machine_id,generation,project_id,revision,seq,checked_at,kind,real_path) VALUES (?,1,?,1,1,1,'accessible','/workspace')",
      )
      .run(machineId, project.id);
    const scope = {
      machineId,
      membershipEpoch: 1,
      directoryRealPath: "/workspace",
      directoryRevision: 1,
      operations: ["shell", "file_read"],
    };
    expect(start.parameters.properties).toHaveProperty("resources");
    const result = outcome(
      await execute("Dispatch with resource scope", { blockMs: 0, resources: [scope] }),
    );
    expect(result.outcome).toBe("queued");
    expect(
      sqlite
        .prepare(
          "SELECT crew_chat_id, delegation_id, run_id, machine_id, membership_epoch, directory_real_path, directory_revision, operations_json, approval, approved_by_profile_id FROM crew_resource_request WHERE delegation_id=?",
        )
        .all(result.delegationId),
    ).toEqual([
      {
        crew_chat_id: target.id,
        delegation_id: result.delegationId,
        run_id: result.runId,
        machine_id: machineId,
        membership_epoch: 1,
        directory_real_path: "/workspace",
        directory_revision: 1,
        operations_json: JSON.stringify([...scope.operations].sort()),
        approval: "approved",
        approved_by_profile_id: lead.id,
      },
    ]);
    const before = count().n;
    const denied = await execute("Invalid resource scope", {
      blockMs: 0,
      resources: [{ ...scope, membershipEpoch: 2 }],
    });
    expect(denied.isError).toBe(true);
    expect(denied.details).toMatchObject({
      outcome: "rejected",
      status: 403,
      error: { code: "forbidden" },
    });
    expect(count().n).toBe(before);
  });

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
    expect(b).toEqual({ ...a, reused: true });
    expect(a).toHaveProperty("reused", false);
    expect(childRun(a.childChatId).status).toBe("queued");
  });
  it("reuses an implicit intent across lead runs, but separates changed text and workers", async () => {
    const before = count().n;
    const a = outcome(await execute("intent A", { blockMs: 0 }));
    const b = outcome(await execute("intent B", { blockMs: 0 }));
    const c = outcome(
      await execute("intent A", { blockMs: 0 }, tool(15000, newId(ID_PREFIXES.run))),
    );
    const d = outcome(await execute("intent A", { blockMs: 0, workerProfileId: otherWorker.id }));
    expect(count().n - before).toBe(3);
    expect(new Set([a.delegationId, b.delegationId, d.delegationId]).size).toBe(3);
    expect(c).toEqual({ ...a, reused: true });
  });
  it("reuses the same worker from an actually later authenticated lead run", async () => {
    const chat = crew();
    const handles: InstanceType<typeof PiSessionProcess>[] = [];
    const runIds: string[] = [];
    async function nextLeadTool() {
      chats.sendMessage(
        chat.id,
        { senderKind: "human", senderId: ctx.userId, body: "Next lead turn" },
        ctx,
      );
      const run = runs.listAgentRuns(chat.id, ctx).find((item) => item.status === "queued")!;
      markRunning(run, lead);
      const handle = new PiSessionProcess(run.id, runnerPath);
      handles.push(handle);
      runIds.push(run.id);
      const remoteGrant = issueRemoteToolGrant(run.id, handle, runtime);
      return { run, definition: tool(15000, run.id, remoteGrant) };
    }
    try {
      const firstLead = await nextLeadTool();
      const first = outcome(
        await execute("cross-run request", { blockMs: 0 }, firstLead.definition),
      );
      completeRun(firstLead.run, lead);
      const secondLead = await nextLeadTool();
      const second = outcome(
        await execute("cross-run request", { blockMs: 0 }, secondLead.definition),
      );
      expect(secondLead.run.id).not.toBe(firstLead.run.id);
      expect(second).toEqual({ ...first, reused: true });
      expect(count(chat.id).n).toBe(1);
      expect(runs.listAgentRuns(first.childChatId, ctx)).toHaveLength(1);
    } finally {
      for (const id of runIds) revokeRemoteToolGrant(id, runtime);
      await Promise.all(handles.map((handle) => handle.close()));
    }
  });
  it.each(["queued", "running", "blocked", "canceling"])(
    "reuses a %s delegation after request normalization",
    async (status) => {
      const request = `normalized ${status}\n  preserve code spacing`;
      const first = outcome(await execute(request, { blockMs: 0 }));
      sqlite.prepare("UPDATE delegation SET status=? WHERE id=?").run(status, first.delegationId);
      const before = count().n;
      const second = outcome(
        await execute(`  ${request.replace(/\n/g, "\r\n")}  `, { blockMs: 0 }),
      );
      expect(second.delegationId).toBe(first.delegationId);
      expect(second).toHaveProperty("reused", true);
      expect(count().n).toBe(before);
    },
  );
  it.each(["completed", "failed", "canceled"])(
    "never reuses a %s delegation, even within the same lead run",
    async (status) => {
      const request = `terminal ${status}`;
      const first = outcome(await execute(request, { blockMs: 0 }));
      sqlite
        .prepare("UPDATE delegation SET status=?, settled_at=?, terminal_reason=? WHERE id=?")
        .run(status, Math.floor(Date.now() / 1000), status, first.delegationId);
      const before = count().n;
      const second = outcome(await execute(request, { blockMs: 0 }));
      expect(second.delegationId).not.toBe(first.delegationId);
      expect(second).toHaveProperty("reused", false);
      expect(count().n).toBe(before + 1);
    },
  );
  it("keeps internal whitespace, letter case and a different crew as distinct requests", async () => {
    const first = outcome(await execute("exact  spacing", { blockMs: 0 }));
    const spacing = outcome(await execute("exact spacing", { blockMs: 0 }));
    const casing = outcome(await execute("Exact  spacing", { blockMs: 0 }));
    expect(new Set([first.delegationId, spacing.delegationId, casing.delegationId]).size).toBe(3);
    const otherCrew = crew();
    const other = delegations.dispatchDelegation(
      { chatId: otherCrew.id, workerProfileId: worker.id, request: "exact  spacing" },
      ctx,
    );
    expect(other.delegationId).not.toBe(first.delegationId);
  });
  it("serializes simultaneous implicit retries into one child chat and worker run", async () => {
    const before = count().n;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => execute("concurrent implicit retry", { blockMs: 0 })),
    );
    const values = results.map(outcome);
    expect(new Set(values.map((value) => value.delegationId)).size).toBe(1);
    expect(values.filter((value) => "reused" in value && value.reused)).toHaveLength(3);
    expect(count().n).toBe(before + 1);
    expect(runs.listAgentRuns(values[0]!.childChatId, ctx)).toHaveLength(1);
  });
  it("gives an explicit clientRequestId priority over implicit intent", async () => {
    const before = count().n;
    const a = outcome(await execute("explicit A", { clientRequestId: "explicit", blockMs: 0 }));
    const b = outcome(await execute("explicit B", { clientRequestId: "explicit", blockMs: 0 }));
    expect(count().n - before).toBe(1);
    expect(b.delegationId).toBe(a.delegationId);
  });
  it("preserves explicit key replay of a terminal delegation and separate keys for identical text", async () => {
    const request = "explicit identical request";
    const first = outcome(
      await execute(request, { clientRequestId: "explicit-terminal", blockMs: 0 }),
    );
    const separate = outcome(
      await execute(request, { clientRequestId: "explicit-separate", blockMs: 0 }),
    );
    expect(separate.delegationId).not.toBe(first.delegationId);
    sqlite
      .prepare(
        "UPDATE delegation SET status='completed', settled_at=?, terminal_reason='completed' WHERE id=?",
      )
      .run(Math.floor(Date.now() / 1000), first.delegationId);
    const replay = outcome(
      await execute("Changed request is still the same explicit key", {
        clientRequestId: "explicit-terminal",
        blockMs: 0,
      }),
    );
    expect(replay.delegationId).toBe(first.delegationId);
    expect(replay).not.toHaveProperty("reused");
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
