import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "assistant-gateway-"));
process.env.DATABASE_URL = join(directory, "gateway.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
const { startRuntime, shutdownRuntime, machineRuntimeContext } =
  await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { remoteAgentRequestSchema } = await import("../src/contracts/remote");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const { PiSessionProcess } = await import("../src/server/pi-host/process");
const { issueRemoteToolGrant, remoteAgentResponse, revokeRemoteToolGrant } =
  await import("../src/server/remote-agent-gateway");
const { initializeRequestContext } = await import("../src/server/request-context");
const ctx = { userId: "gateway-human", requestId: "req_11111111" };
for (const human of [ctx.userId, "other-human"])
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(human, human, `${human}@example.test`);
const project = createProject({ name: "Source" }, ctx);
const authorized = createProject({ name: "Human other Project" }, ctx);
const foreign = createProject({ name: "Other Human" }, { ...ctx, userId: "other-human" });
const profiles = [
  createAgentProfile({ name: "Assistant", purpose: "assistant" }, ctx),
  createAgentProfile({ name: "Worker" }, ctx),
];
const runnerPath = join(directory, "transport.mjs");
writeFileSync(
  runnerPath,
  "import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{if(JSON.parse(line).type==='close')process.exit(0)});",
);
const processes: InstanceType<typeof PiSessionProcess>[] = [];
const grants: ReturnType<typeof issueRemoteToolGrant>[] = [];
const active: ReturnType<typeof runs.getAgentRun>[] = [];
const runtime = { ...(await machineRuntimeContext()), requestId: ctx.requestId };
for (const profile of profiles) {
  addProjectMember(project.id, profile.id, ctx);
  const chat = chats.createDirectChat(project.id, profile.id, ctx).chat;
  chats.sendMessage(chat.id, { senderKind: "human", senderId: ctx.userId, body: "Start" }, ctx);
  const run = runs.listAgentRuns(chat.id, ctx)[0];
  const process = new PiSessionProcess(run.id, runnerPath);
  processes.push(process);
  grants.push(issueRemoteToolGrant(run.id, process, runtime));
  runs.transitionAgentRun(
    run.id,
    "running",
    {
      configSnapshot: {
        purpose: profile.purpose,
        provider: "transport",
        model: "none",
        thinking: "off",
        tools: [],
        extensions: [],
        sessionId: run.sessionId,
        sessionFile: join(directory, `${run.id}.jsonl`),
        cwd: directory,
        sdkVersion: "transport",
        profile: {
          purpose: profile.purpose,
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
  active.push(runs.getAgentRun(run.id, ctx));
}
async function invoke(index: number, type: string, input: unknown, secret = grants[index].secret) {
  const request = new Request("http://127.0.0.1/api/remote/agent", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ version: 2, call: { type, input } }),
  });
  initializeRequestContext(request);
  const response = await remoteAgentResponse(request);
  return { status: response.status, body: await response.json() };
}
afterAll(async () => {
  for (const run of active) revokeRemoteToolGrant(run.id, runtime);
  await Promise.all(processes.map((process) => process.close()));
  await shutdownRuntime("assistant-gateway-done");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
describe("assistant/worker gateway purpose and Human authority matrix", () => {
  it("admits assistant factual reads across authorized Projects but not foreign Human or forged identity", async () => {
    expect(
      (
        await invoke(0, "assistant_observe", {
          projectId: project.id,
          targetProjectId: authorized.id,
        })
      ).body,
    ).toMatchObject({ ok: true });
    for (const input of [
      { projectId: project.id, targetProjectId: foreign.id },
      { projectId: authorized.id },
      { projectId: project.id, targetProjectId: foreign.id, userId: "other-human" },
      {
        projectId: project.id,
        targetProjectId: project.id,
        runId: active[1].id,
        chatId: active[0].chatId,
      },
      { projectId: project.id, targetProjectId: foreign.id, chatId: active[1].chatId },
      {
        projectId: project.id,
        targetProjectId: authorized.id,
        runId: active[1].id,
        chatId: active[1].chatId,
      },
    ])
      expect((await invoke(0, "assistant_observe", input)).body.ok).toBe(false);
    expect(
      (await invoke(0, "assistant_observe", { projectId: project.id }, "wrong-secret")).status,
    ).toBe(401);
  });
  it("denies every ordinary gateway call with assistant grants and assistant calls with worker grants", async () => {
    const projectScope = { projectId: project.id };
    const leaseScope = { ...projectScope, machineId: "mch_11111111" };
    const executionScope = { ...leaseScope, executionId: "exe_11111111" };
    const mcpScope = { ...leaseScope, authorizationGeneration: 1 };
    const forbidden: Record<string, unknown> = {
      chat_get: projectScope,
      chat_send: { ...projectScope, body: "Forged" },
      chat_continuation_get: projectScope,
      task_list: projectScope,
      task_get: { ...projectScope, taskId: "tsk_11111111" },
      task_mutate: {
        ...projectScope,
        taskId: "tsk_11111111",
        expectedRevision: 1,
        action: "update",
        title: "Forged",
      },
      lease_get: leaseScope,
      lease_mutate: {
        ...leaseScope,
        action: "acquire",
        requestId: "req_11111111",
        expectedGeneration: 0,
      },
      execution_submit: {
        ...leaseScope,
        requestId: "req_11111111",
        authorizationGeneration: 1,
        operation: { kind: "shell", command: "true" },
      },
      execution_get: executionScope,
      execution_list: leaseScope,
      execution_cancel: {
        ...executionScope,
        requestId: "req_11111111",
        authorizationGeneration: 1,
      },
      execution_log_read: { ...executionScope, cursor: null },
      info_hub_get: { ...projectScope, view: "project", section: "chats" },
      mcp_catalog_get: mcpScope,
      mcp_session_open: {
        ...mcpScope,
        requestId: "req_11111111",
        registrationId: "mrg_11111111",
        registrationRevision: 1,
        processId: "mpr_11111111",
        expectedWorkerIncarnationId: "11111111-1111-4111-8111-111111111111",
      },
      mcp_session_exchange: {
        ...mcpScope,
        sessionId: "mcs_11111111",
        frames: [],
        ackServerSeq: 0,
        cancelClientSeqs: [],
        protocolVersion: null,
        confirmInitialized: false,
        holdMs: 0,
      },
      mcp_session_close: {
        ...mcpScope,
        sessionId: "mcs_11111111",
        requestId: "req_11111111",
        reason: "client_closed",
      },
    };
    const actualCalls = remoteAgentRequestSchema.shape.call.options
      .map((option) => option.shape.type.value)
      .filter((type) => !type.startsWith("assistant_"));
    expect(Object.keys(forbidden).sort()).toEqual(actualCalls.sort());
    for (const [type, input] of Object.entries(forbidden)) {
      expect(
        remoteAgentRequestSchema.safeParse({ version: 2, call: { type, input } }).success,
        type,
      ).toBe(true);
      expect((await invoke(0, type, input)).body.ok, type).toBe(false);
    }
    const assistantInputs = {
      assistant_observe: projectScope,
      assistant_watch: { ...projectScope, targetProjectId: project.id, chatId: active[1].chatId },
      assistant_propose: {
        ...projectScope,
        target: {
          kind: "dm_agent",
          projectId: project.id,
          chatId: active[1].chatId,
          agentProfileId: active[1].configSnapshot!.profile.id,
        },
        body: "Forged",
      },
    };
    for (const [type, input] of Object.entries(assistantInputs)) {
      expect(
        remoteAgentRequestSchema.safeParse({ version: 2, call: { type, input } }).success,
        type,
      ).toBe(true);
      expect((await invoke(1, type, input)).body.ok, type).toBe(false);
    }
    expect((await invoke(1, "chat_get", { projectId: authorized.id })).body.ok).toBe(false);
    expect((await invoke(1, "chat_get", { projectId: project.id })).body.ok).toBe(true);
  });
  it("revokes a live assistant grant when current Human source rights disappear", async () => {
    sqlite.prepare("UPDATE chat SET archived_at=1 WHERE id=?").run(active[0].chatId);
    expect(
      (
        await invoke(0, "assistant_observe", {
          projectId: project.id,
          targetProjectId: authorized.id,
        })
      ).body.ok,
    ).toBe(false);
    sqlite.prepare("UPDATE chat SET archived_at=NULL WHERE id=?").run(active[0].chatId);
  });
});
