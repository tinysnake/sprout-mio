import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startModelFixture } from "../../scripts/verify/lib/model-fixture.mjs";

const directory =
  process.env.ASSISTANT_FEEDBACK_DIR ?? mkdtempSync(join(tmpdir(), "assistant-feedback-"));
mkdirSync(directory, { recursive: true });
const fixture = await startModelFixture({ privateDir: directory });
let dispatch: (request: Request) => Promise<Response>;
let initialize: (request: Request) => unknown;
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body: Buffer.concat(chunks),
    });
    initialize(request);
    const response = await dispatch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch (error) {
    outgoing.writeHead(500);
    outgoing.end(String(error));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
Object.assign(process.env, {
  DATABASE_URL: join(directory, "app.sqlite"),
  PI_CODING_AGENT_DIR: fixture.agentDir,
  PI_TELEMETRY: "0",
  SPROUT_PI_ENABLED: "true",
  SPROUT_PI_DATA_DIR: join(directory, "pi"),
  SPROUT_REPO_DIR: join(directory, "repos"),
  SPROUT_PI_INHERIT_HOST_RESOURCES: "false",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  PORT: String(address.port),
  APP_ORIGIN: `http://127.0.0.1:${address.port}`,
});
const { migrateDatabase } = await import("../../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../../src/db");
const { startRuntime, shutdownRuntime } = await import("../../src/server/runtime");
({ remoteAgentResponse: dispatch } = await import("../../src/server/remote-agent-gateway"));
({ initializeRequestContext: initialize } = await import("../../src/server/request-context"));
const { createProject } = await import("../../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../../src/domain/agent");
const chats = await import("../../src/domain/chat");
const assistant = await import("../../src/domain/assistant");
const { setAssistantWatch } = await import("../../src/domain/assistant-observer");
const ctx = { userId: "feedback-human", requestId: "req_11111111" };
const until = async <T>(read: () => T | undefined, label: string) => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    fixture.assertHealthy();
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
};
type FinishedRun = {
  id: string;
  config_snapshot: string;
  status: string;
  error_message: string | null;
};
const finished = (chatId: string) =>
  until(
    () =>
      sqlite
        .prepare(
          "SELECT * FROM agent_run WHERE chat_id=? AND status IN ('completed','failed') ORDER BY rowid DESC",
        )
        .get(chatId) as FinishedRun | undefined,
    "actual installed Pi run",
  );
function toolResults(run: FinishedRun) {
  assert.equal(run.status, "completed", run.error_message ?? "completed model turn");
  const snapshot = JSON.parse(run.config_snapshot);
  return {
    snapshot,
    tools: readFileSync(snapshot.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.message?.role === "toolResult")
      .map((entry) => entry.message),
  };
}
try {
  await startRuntime();
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(ctx.userId, "Human", "feedback@example.test");
  const project = createProject({ name: "Feedback native assistant" }, ctx);
  const helper = createAgentProfile(
    {
      name: "Native assistant",
      purpose: "assistant",
      model: fixture.model("status"),
      effort: "off",
    },
    ctx,
  );
  const worker = createAgentProfile(
    { name: "Amenda", model: fixture.model("chatMentioned"), effort: "off" },
    ctx,
  );
  for (const profile of [helper, worker]) addProjectMember(project.id, profile.id, ctx);
  const source = chats.createDirectChat(project.id, helper.id, ctx).chat;
  const initialDmCount = sqlite
    .prepare("SELECT count(*) n FROM chat WHERE project_id=? AND kind='dm'")
    .get(project.id) as { n: number };
  const prompt = "Observe Project workers, propose hi to Amenda and request a 60 second watch";
  fixture.arm("status", {
    expectedUserText: prompt,
    steps: [
      { name: "sprout_status", arguments: {} },
      { name: "sprout_assistant_observe", arguments: { targetProjectId: project.id } },
      {
        name: "sprout_assistant_propose",
        arguments: {
          target: { kind: "dm_agent", projectId: project.id, agentProfileId: worker.id },
          body: "hi",
        },
      },
    ],
    reply: "Amenda is visible without an existing DM; hi is ready for Human confirmation.",
  });
  chats.sendMessage(source.id, { senderKind: "human", senderId: ctx.userId, body: prompt }, ctx);
  const first = await finished(source.id);
  const actual = toolResults(first);
  assert.equal(actual.tools.length, 3);
  for (const tool of actual.tools) assert.equal(tool.isError, false, JSON.stringify(tool));
  const observe = actual.tools.find((tool) => tool.toolName === "sprout_assistant_observe");
  assert(observe);
  const observed = JSON.parse(
    observe.content.find((content: { type: string }) => content.type === "text").text,
  );
  assert.equal(observed.outcome, "response");
  assert.equal(observed.result.ok, true);
  assert(
    observed.result.data.agents.some(
      (agent: { agentProfileId: string }) => agent.agentProfileId === worker.id,
    ),
  );
  assert.equal(
    observed.result.data.chats.filter((chat: { kind: string }) => chat.kind === "dm").length,
    initialDmCount.n,
  );
  const proposal = assistant.assistantPanel(source.id, ctx).proposals[0];
  assert.equal(proposal.body, "hi");
  assert.equal(proposal.target.kind, "dm_agent");
  const target = proposal.target.chatId!;
  assert.equal(
    (
      sqlite.prepare("SELECT count(*) n FROM agent_run WHERE chat_id=?").get(target) as {
        n: number;
      }
    ).n,
    0,
    "propose creates no work before confirmation",
  );
  fixture.arm("chatMentioned", {
    expectedUserPrefix: `[Human-confirmed assistant proposal ${proposal.id}; source is program-generated work input]\nhi`,
    steps: [],
    reply: "Hi from Amenda",
  });
  const receipt = assistant.confirmAssistantProposal(proposal.id, source.id, ctx);
  const repeated = assistant.confirmAssistantProposal(proposal.id, source.id, ctx);
  assert.equal(receipt.messageId, repeated.messageId);
  const work = await finished(target);
  assert.equal(
    work.status,
    "completed",
    work.error_message ?? "Amenda actual installed Pi completion",
  );
  assert(chats.listMessages(target, ctx).some((message) => message.body === "Hi from Amenda"));
  const watchPrompt = "Set a 60 second watch interval intent on Amenda";
  fixture.arm("status", {
    expectedUserText: watchPrompt,
    steps: [
      { name: "sprout_assistant_observe", arguments: {} },
      {
        name: "sprout_assistant_observe",
        arguments: { targetProjectId: project.id, chatId: target },
      },
      {
        name: "sprout_assistant_observe",
        arguments: { targetProjectId: project.id, chatId: target, runId: work.id },
      },
      {
        name: "sprout_assistant_watch",
        arguments: { targetProjectId: project.id, chatId: target, intervalSeconds: 60 },
      },
      {
        name: "sprout_assistant_observe",
        arguments: { targetProjectId: project.id, chatId: source.id },
      },
    ],
    reply: "Human watch consent is required.",
  });
  chats.sendMessage(
    source.id,
    { senderKind: "human", senderId: ctx.userId, body: watchPrompt },
    ctx,
  );
  const second = await until(
    () =>
      sqlite
        .prepare(
          "SELECT * FROM agent_run WHERE chat_id=? AND id<>? AND status IN ('completed','failed')",
        )
        .get(source.id, first.id) as FinishedRun | undefined,
    "watch intent roundtrip",
  );
  const secondTools = toolResults(second).tools.slice(actual.tools.length);
  assert.equal(secondTools.length, 5);
  for (const tool of secondTools) assert.equal(tool.isError, false, JSON.stringify(tool));
  const watch = secondTools.find((tool) => tool.toolName === "sprout_assistant_watch");
  assert(watch && !watch.isError, JSON.stringify(watch));
  const watchResult = JSON.parse(
    watch.content.find((content: { type: string }) => content.type === "text").text,
  );
  assert.equal(watchResult.result.data.active, false);
  assert.equal(watchResult.result.data.intervalSeconds, 60);
  assert.equal(assistant.assistantPanel(source.id, ctx).watches.length, 0);
  const intent = assistant
    .assistantPanel(source.id, ctx)
    .decisions.find((event) => event.fact.watchIntent)!;
  setAssistantWatch(source.id, project.id, target, true, ctx, new Date(), 60, intent.id);
  assert.equal(assistant.assistantPanel(source.id, ctx).watches[0].intervalSeconds, 60);
  assert.equal(
    assistant.assistantPanel(source.id, ctx).decisions.filter((event) => event.fact.watchIntent)
      .length,
    0,
  );
  const stopPrompt = "Stop watching Amenda in this DM";
  fixture.arm("status", {
    expectedUserText: stopPrompt,
    steps: [
      {
        name: "sprout_assistant_watch",
        arguments: { targetProjectId: project.id, chatId: target, active: false },
      },
    ],
    reply: "已停止关注 Amenda；不会取消正在执行的工作。",
  });
  chats.sendMessage(
    source.id,
    { senderKind: "human", senderId: ctx.userId, body: stopPrompt },
    ctx,
  );
  const stopped = await until(
    () =>
      sqlite
        .prepare(
          "SELECT * FROM agent_run WHERE chat_id=? AND id NOT IN (?,?) AND status IN ('completed','failed')",
        )
        .get(source.id, first.id, second.id) as FinishedRun | undefined,
    "actual installed Pi stop watch roundtrip",
  );
  const stopTools = toolResults(stopped).tools.slice(actual.tools.length + secondTools.length);
  assert.equal(stopTools.length, 1);
  assert.equal(stopTools[0].toolName, "sprout_assistant_watch");
  assert.equal(stopTools[0].isError, false, JSON.stringify(stopTools));
  const stopResult = JSON.parse(
    stopTools[0].content.find((content: { type: string }) => content.type === "text").text,
  );
  assert.equal(stopResult.result.data.action, "stopped");
  assert.equal(stopResult.result.data.active, false);
  assert.equal(stopResult.result.data.chatId, target);
  assert.equal(assistant.assistantPanel(source.id, ctx).watches.length, 0);
  assert.equal(
    assistant.assistantPanel(source.id, ctx).decisions.filter((event) => event.fact.watchIntent)
      .length,
    0,
  );
  assert.throws(
    () => setAssistantWatch(source.id, project.id, target, true, ctx, new Date(), 60, intent.id),
    /关注意图已处理/,
  );
  fixture.assertDrained();
  const evidence = {
    directory,
    assistantRunId: first.id,
    workerRunId: work.id,
    watchRunId: second.id,
    stopRunId: stopped.id,
    stopResult,
    sdkVersion: actual.snapshot.sdkVersion,
    declaredTools: actual.snapshot.tools,
    observe: observed,
    target,
    messageId: receipt.messageId,
    watchConsent: "Human only",
    fixture: fixture.metadata(),
  };
  writeFileSync(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(
    `PASS installed Pi observe→Agent-only propose→Human confirm→Amenda hi; watch interval intent/consent→actual Pi stop tool; evidence=${join(directory, "evidence.json")}`,
  );
} finally {
  await shutdownRuntime("assistant-feedback-done");
  await fixture.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sqlite.close();
}
