import { afterAll, describe, expect, it } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SproutExtensionAPI } from "../src/extension/types";
type SproutToolDefinition = Parameters<SproutExtensionAPI["registerTool"]>[0];
import type { RemoteAgentRequest } from "../src/contracts/remote";

// Real SQLite + runtime + process-scoped grants + HTTP gateway; the child process
// only keeps a transport alive. No model execution is claimed by this suite.
const directory = mkdtempSync(join(tmpdir(), "p5b-task-tools-"));
process.env.DATABASE_URL = join(directory, "tools.sqlite");
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_ENABLED = "false";
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
let gateway: (request: Request) => Promise<Response>;
let requestCount = 0;
let corrupt: ((data: unknown) => unknown) | undefined;
const server = createServer(async (req, res) => {
  try {
    requestCount++;
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
    const payload: unknown = await response.json();
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(JSON.stringify(corrupt ? corrupt(payload) : payload));
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("HTTP address missing");
process.env.APP_ORIGIN = `http://127.0.0.1:${address.port}`;
const { startRuntime, shutdownRuntime, machineRuntimeContext } =
  await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const tasks = await import("../src/domain/task");
const runs = await import("../src/domain/agent-run");
const { PiSessionProcess } = await import("../src/server/pi-host/process");
const { issueRemoteToolGrant, revokeRemoteToolGrant, remoteAgentResponse } =
  await import("../src/server/remote-agent-gateway");
const { initializeRequestContext } = await import("../src/server/request-context");
gateway = (request) => {
  initializeRequestContext(request);
  return remoteAgentResponse(request);
};
const { createRemoteClient } = await import("../src/extension/remote-client");
const { registerTaskTools } = await import("../src/extension/task-tools");
const { taskToolInputSchemas, taskDetailSchema, taskCommandResultSchema } =
  await import("../src/contracts/task");
const { taskListResponseSchema, chatGetResponseSchema, chatSendResponseSchema } =
  await import("../src/contracts/remote");
const ctx = { userId: "task-tools-human", requestId: newId(ID_PREFIXES.request) };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, ctx.userId, "tools@test.example");
const project = createProject({ name: "Task tools" }, ctx);
const alpha = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const beta = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
for (const profile of [alpha, beta]) addProjectMember(project.id, profile.id, ctx);
const human = { kind: "human" as const, userId: ctx.userId, ctx };
function group() {
  return chats.createGroupChat(
    project.id,
    {
      projectId: project.id,
      title: "Tool scope",
      wakePolicy: "owner_led",
      initialOwner: { kind: "agent", id: alpha.id },
      members: [
        { kind: "human", id: ctx.userId },
        { kind: "agent", id: alpha.id },
        { kind: "agent", id: beta.id },
      ],
    },
    human,
  );
}
const target = group();
const foreignChat = group();
function task(chatId = target.id) {
  const detail = tasks.createTask(
    { projectId: project.id, title: "Tool Task", checklist: ["one"] },
    ctx,
  ).detail;
  return tasks.assignTask(
    { taskId: detail.task.id, expectedRevision: detail.task.revision, targetChatId: chatId },
    ctx,
  ).detail;
}
const owned = task();
const foreign = task(foreignChat.id);
chats.sendMessage(
  target.id,
  { senderKind: "human", senderId: ctx.userId, body: "@Alpha @Beta" },
  ctx,
);
const ownerRun = runs
  .listAgentRuns(target.id, ctx)
  .find((r) => chats.getInstance(r.instanceId, ctx).agentProfileId === alpha.id)!;
const memberRun = runs
  .listAgentRuns(target.id, ctx)
  .find((r) => chats.getInstance(r.instanceId, ctx).agentProfileId === beta.id)!;
const runnerPath = join(directory, "grant-transport.mjs");
writeFileSync(
  runnerPath,
  `import {createInterface} from 'node:readline';\ncreateInterface({input:process.stdin}).on('line', line => {if(JSON.parse(line).type==='close')process.exit(0)});\n`,
);
const processes = [
  new PiSessionProcess(ownerRun.id, runnerPath),
  new PiSessionProcess(memberRun.id, runnerPath),
];
const runtime = { ...(await machineRuntimeContext()), requestId: ctx.requestId };
const grants = [
  issueRemoteToolGrant(ownerRun.id, processes[0]!, runtime),
  issueRemoteToolGrant(memberRun.id, processes[1]!, runtime),
];
for (const [run, profile] of [
  [ownerRun, alpha],
  [memberRun, beta],
] as const) {
  runs.transitionAgentRun(
    run.id,
    "running",
    {
      configSnapshot: {
        provider: "grant-transport",
        model: "none",
        thinking: "off",
        tools: [],
        extensions: [],
        sessionId: run.sessionId,
        sessionFile: join(directory, `${run.id}.jsonl`),
        cwd: directory,
        sdkVersion: "transport-test",
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
const clients = grants.map((grant) => createRemoteClient(grant));
const toolsets = clients.map((client) => {
  const tools = new Map<string, SproutToolDefinition>();
  registerTaskTools(
    {
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
    },
    client,
  );
  return tools;
});
const command = (id = owned.task.id) => ({
  taskId: id,
  expectedRevision: tasks.getTaskDetail(id, ctx).task.revision,
});
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);
async function invoke(name: string, input: unknown = {}, member = false) {
  const result = await toolsets[member ? 1 : 0]!.get(name)!.execute("call", input);
  const content = result.content[0];
  if (content.type !== "text") throw new Error("Expected text");
  return { result, envelope: envelopeSchema.safeParse(JSON.parse(content.text)) };
}
async function data(name: string, input: unknown = {}, member = false): Promise<unknown> {
  const { result, envelope } = await invoke(name, input, member);
  expect(result.isError, JSON.stringify(result.details)).toBe(false);
  if (!envelope.success || !envelope.data.ok) throw new Error("Successful tool response expected");
  return envelope.data.data;
}
async function rejected(name: string, input: unknown, code: string, member = false) {
  const { result, envelope } = await invoke(name, input, member);
  expect(result.isError).toBe(true);
  expect(envelope.success, JSON.stringify(result.details)).toBe(true);
  expect(envelope.success && envelope.data).toMatchObject({ ok: false, error: { code } });
}
afterAll(async () => {
  for (const run of [ownerRun, memberRun]) revokeRemoteToolGrant(run.id, runtime);
  await Promise.all(processes.map((process) => process.close()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await shutdownRuntime("task-agent-tools-done");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("run-scoped Agent Task/Chat tools", () => {
  it("registers exactly the 11 permitted tools and rejects identity/scope fields before transport", async () => {
    expect([...toolsets[0]!.keys()].sort()).toEqual(Object.keys(taskToolInputSchemas).sort());
    const examples: Record<keyof typeof taskToolInputSchemas, object> = {
      sprout_task_list: {},
      sprout_task_get: { taskId: owned.task.id },
      sprout_chat_get: {},
      sprout_chat_send: { body: "message" },
      sprout_task_update: command(),
      sprout_task_checklist_add: { ...command(), body: "item" },
      sprout_task_checklist_update: { ...command(), itemId: owned.checklist[0]!.id, checked: true },
      sprout_task_checklist_remove: { ...command(), itemId: owned.checklist[0]!.id },
      sprout_task_record_append: { ...command(), body: "record" },
      sprout_task_complete: command(),
      sprout_task_cancel: command(),
    };
    const before = requestCount;
    for (const name of Object.keys(examples) as (keyof typeof examples)[]) {
      for (const field of [
        "sender",
        "senderId",
        "senderKind",
        "actor",
        "runId",
        "instanceId",
        "agentProfileId",
        "userId",
        "projectId",
        "chatId",
      ])
        await rejected(name, { ...examples[name], [field]: "forged" }, "validation_failed");
    }
    expect(requestCount).toBe(before);
  });
  it("injects project from the grant and confines Task listing/reads and Chat reads/writes to its real run", async () => {
    const list = taskListResponseSchema.parse(await data("sprout_task_list"));
    expect(list).toMatchObject({ projectId: project.id, chatId: target.id });
    expect(list.items.map((item) => item.id)).toContain(owned.task.id);
    expect(list.items.map((item) => item.id)).not.toContain(foreign.task.id);
    expect(
      taskDetailSchema.parse(await data("sprout_task_get", { taskId: owned.task.id })).task.id,
    ).toBe(owned.task.id);
    await rejected("sprout_task_get", { taskId: foreign.task.id }, "not_found");
    const session = chatGetResponseSchema.parse(await data("sprout_chat_get"));
    expect(session.chatId).toBe(target.id);
    const sent = chatSendResponseSchema.parse(
      await data("sprout_chat_send", { body: "Agent tool message" }),
    );
    expect(sent).toMatchObject({
      chatId: target.id,
      message: { senderKind: "agent", senderId: alpha.id, body: "Agent tool message" },
    });
    expect(
      chats.listMessages(foreignChat.id, ctx).some((message) => message.id === sent.message.id),
    ).toBe(false);
    const beforeCollaboration = (
      sqlite.prepare("SELECT count(*) AS n FROM agent_run_input").get() as { n: number }
    ).n;
    await data("sprout_chat_send", { body: "@Beta collaborate via gateway" });
    await data("sprout_chat_send", { body: "@Alpha member response via gateway" }, true);
    expect(
      (sqlite.prepare("SELECT count(*) AS n FROM agent_run_input").get() as { n: number }).n,
    ).toBe(beforeCollaboration + 1);
    const forged: RemoteAgentRequest = {
      version: 2,
      call: { type: "task_list", input: { projectId: newId(ID_PREFIXES.project) } },
    };
    expect(await clients[0]!.request(forged)).toMatchObject({
      outcome: "response",
      result: { ok: false, error: { code: "not_found" } },
    });
    const anonymous = await gateway(
      new Request(grants[0]!.endpoint, { method: "POST", body: JSON.stringify(forged) }),
    );
    expect(anonymous.status).toBe(401);
  });
  it("runs every permitted mutation through gateway with owner/member capability checks and real author run", async () => {
    await rejected(
      "sprout_task_update",
      { ...command(), title: "forbidden member" },
      "forbidden",
      true,
    );
    await rejected("sprout_task_complete", command(), "forbidden", true);
    await rejected("sprout_task_cancel", command(), "forbidden", true);
    const updated = taskCommandResultSchema.parse(
      await data("sprout_task_update", { ...command(), title: "Owner updated" }),
    );
    expect(updated.detail.task.title).toBe("Owner updated");
    const added = taskCommandResultSchema.parse(
      await data("sprout_task_checklist_add", { ...command(), body: "Added remotely" }),
    );
    const item = added.detail.checklist.find((item) => item.body === "Added remotely")!;
    const changed = taskCommandResultSchema.parse(
      await data("sprout_task_checklist_update", { ...command(), itemId: item.id, checked: true }),
    );
    expect(changed.detail.checklist.find((entry) => entry.id === item.id)?.checked).toBe(true);
    const removed = taskCommandResultSchema.parse(
      await data("sprout_task_checklist_remove", { ...command(), itemId: item.id }),
    );
    expect(removed.detail.checklist.some((entry) => entry.id === item.id)).toBe(false);
    const record = taskCommandResultSchema.parse(
      await data("sprout_task_record_append", { ...command(), body: "Member progress" }, true),
    );
    expect(record.detail.lastRecord).toMatchObject({
      senderKind: "agent",
      senderId: beta.id,
      authorRunId: memberRun.id,
    });
    const message = chats
      .listMessages(target.id, ctx)
      .find((message) => message.taskRecord?.taskId === owned.task.id)!;
    expect(message.taskRecord?.authorRunId).toBe(memberRun.id);
    const completed = taskCommandResultSchema.parse(await data("sprout_task_complete", command()));
    expect(completed.detail.task.status).toBe("finished");
    const another = task();
    const canceled = taskCommandResultSchema.parse(
      await data("sprout_task_cancel", command(another.task.id)),
    );
    expect(canceled.detail.task.status).toBe("canceled");
  });
  it("rejects forbidden actions and caller identities even when bypassing the registered tools", async () => {
    for (const action of ["create", "assign", "start", "reopen", "correct"]) {
      const response = await gateway(
        new Request(grants[0]!.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${grants[0]!.secret}` },
          body: JSON.stringify({
            version: 2,
            call: { type: "task_mutate", input: { projectId: project.id, action, ...command() } },
          }),
        }),
      );
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "validation_failed" },
      });
    }
    const response = await gateway(
      new Request(grants[0]!.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${grants[0]!.secret}` },
        body: JSON.stringify({
          version: 2,
          call: {
            type: "chat_send",
            input: {
              projectId: project.id,
              body: "forged",
              senderKind: "human",
              senderId: ctx.userId,
            },
          },
        }),
      }),
    );
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  });
  it("treats extra fields and mismatched project/task/chat/sender response bindings as invalid", async () => {
    const validTask = tasks.getTaskDetail(owned.task.id, ctx);
    const validList = taskListResponseSchema.parse(await data("sprout_task_list"));
    const cases: { request: RemoteAgentRequest; data: unknown }[] = [
      {
        request: {
          version: 2,
          call: { type: "task_get", input: { projectId: project.id, taskId: owned.task.id } },
        },
        data: { ...validTask, injected: true },
      },
      {
        request: {
          version: 2,
          call: { type: "task_get", input: { projectId: project.id, taskId: owned.task.id } },
        },
        data: { ...validTask, task: { ...validTask.task, id: foreign.task.id } },
      },
      {
        request: {
          version: 2,
          call: {
            type: "task_mutate",
            input: { projectId: project.id, action: "update", ...command() },
          },
        },
        data: { detail: validTask, extra: "not permitted" },
      },
      {
        request: {
          version: 2,
          call: {
            type: "task_mutate",
            input: { projectId: project.id, action: "update", ...command() },
          },
        },
        data: { detail: { ...validTask, task: { ...validTask.task, id: foreign.task.id } } },
      },
      {
        request: { version: 2, call: { type: "task_list", input: { projectId: project.id } } },
        data: { ...validList, projectId: newId(ID_PREFIXES.project) },
      },
      {
        request: { version: 2, call: { type: "task_list", input: { projectId: project.id } } },
        data: {
          ...validList,
          items: validList.items.map((item) => ({ ...item, chatId: foreignChat.id })),
        },
      },
    ];
    const sent = chatSendResponseSchema.parse(
      await data("sprout_chat_send", { body: "response binding" }),
    );
    cases.push({
      request: {
        version: 2,
        call: { type: "chat_send", input: { projectId: project.id, body: "response binding" } },
      },
      data: { ...sent, message: { ...sent.message, senderKind: "human" } },
    });
    cases.push({
      request: { version: 2, call: { type: "chat_get", input: { projectId: project.id } } },
      data: {
        ...chatGetResponseSchema.parse(await data("sprout_chat_get")),
        chatId: foreignChat.id,
      },
    });
    try {
      for (const test of cases) {
        corrupt = () => ({ ok: true, data: test.data, requestId: ctx.requestId });
        expect(await clients[0]!.request(test.request)).toEqual({
          outcome: "unknown",
          reason: "invalid_response",
        });
      }
    } finally {
      corrupt = undefined;
    }
  });
});
