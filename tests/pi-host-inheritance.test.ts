import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProjectContext } from "../src/domain/access";

/**
 * 继承开关的生产接线：`SPROUT_PI_INHERIT_HOST_RESOURCES` 在父进程解析，随 open 命令显式
 * 传给 runner，并在 ready 快照里落库。真实 Pi 侧的装载边界由 `p7-pi-inheritance` 门禁证明；
 * 这里只证明「开关到了 runner」与「快照不被协议丢掉」。
 */
const directory = mkdtempSync(join(tmpdir(), "pi-host-inheritance-"));
process.env.DATABASE_URL = join(directory, "inheritance.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../src/db");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const { startRuntime, shutdownRuntime } = await import("../src/server/runtime");
const { PiSessionProcess } = await import("../src/server/pi-host/process");
const { executeRun } = await import("../src/server/pi-host/run");

const ctx: ProjectContext = {
  userId: "inheritance-human",
  requestId: newId(ID_PREFIXES.request),
};
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, ctx.userId, "inheritance@test.example");
const project = createProject({ name: "Inheritance" }, ctx);
const profile = createAgentProfile({ name: "Inheritance Agent", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, profile.id, ctx);

/** 只走线上协议的 runner：记录 open，回一个带 resources 的 ready，再正常答完一轮。 */
function writeRunner() {
  const trace = join(directory, "open.jsonl");
  const runnerPath = join(directory, "inheritance-runner.mjs");
  writeFileSync(
    runnerPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'close') process.exit(0);
  if (command.type === 'open') {
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify(command) + '\\n');
    out({
      type: 'ready',
      id: command.id,
      snapshot: {
        provider: 'inheritance-test',
        model: 'none',
        thinking: 'off',
        tools: ['bash', 'edit', 'read', 'write'],
        registeredTools: ['bash', 'edit', 'read', 'sprout_status', 'write'],
        extensions: ['sprout-extension'],
        sessionId: command.sessionId,
        sessionFile: command.sessionDirectory + '/inheritance.jsonl',
        cwd: command.cwd,
        sdkVersion: 'inheritance-test',
        resources: {
          inheritHostResources: command.inheritHostResources === true,
          agentDir: command.cwd + '/.sprout-pi',
          hostAgentDir: command.agentDir,
          skillPaths: command.inheritHostResources === true ? [command.agentDir + '/skills'] : [],
          promptPaths:
            command.inheritHostResources === true ? [command.agentDir + '/prompts'] : [],
          skills: command.inheritHostResources === true ? ['host-skill'] : [],
          prompts: command.inheritHostResources === true ? ['host-prompt'] : [],
          themes: [],
          contextFiles: [],
          systemPromptChars: command.inheritHostResources === true ? 512 : 128,
        },
        profile: command.profile,
      },
    });
  }
  if (command.type === 'prompt') {
    out({ type: 'input_delivered', id: command.id, messageId: command.messageId });
    out({ type: 'settled', id: command.id, text: 'inheritance transport reply', stopReason: 'stop' });
  }
});
`,
  );
  return {
    runnerPath,
    opened: () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

/** 一个全新的 DM run，跑完一轮后返回落库的配置快照。 */
async function runWithSwitch(inherit: boolean | undefined) {
  const { runnerPath, opened } = writeRunner();
  const direct = chats.createDirectChat(project.id, profile.id, ctx);
  chats.sendMessage(
    direct.chat.id,
    { senderKind: "human", senderId: ctx.userId, body: "inheritance input" },
    ctx,
  );
  const run = runs.listAgentRuns(direct.chat.id, ctx).find((entry) => entry.status === "queued")!;
  const work = runs.queuedRunWork().find((entry) => entry.run.id === run.id)!;
  const previous = process.env.SPROUT_PI_INHERIT_HOST_RESOURCES;
  if (inherit === undefined) delete process.env.SPROUT_PI_INHERIT_HOST_RESOURCES;
  else process.env.SPROUT_PI_INHERIT_HOST_RESOURCES = inherit ? "1" : "false";
  const transport = new PiSessionProcess(run.id, runnerPath);
  try {
    await Effect.runPromise(
      executeRun(work, transport, { isStopping: () => false }) as Effect.Effect<void>,
    );
  } finally {
    await transport.close();
    if (previous === undefined) delete process.env.SPROUT_PI_INHERIT_HOST_RESOURCES;
    else process.env.SPROUT_PI_INHERIT_HOST_RESOURCES = previous;
  }
  const open = opened().find((command) => command.id === run.id);
  return { runId: run.id, open, snapshot: runs.getAgentRun(run.id, ctx).configSnapshot };
}

await startRuntime();
afterAll(async () => {
  await shutdownRuntime("pi-host-inheritance-test");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Pi 资源继承开关的父进程接线", () => {
  it("缺省关闭：open 不要求继承，快照记录关闭且资源为空", async () => {
    const { open, snapshot } = await runWithSwitch(undefined);
    expect(open.inheritHostResources).toBe(false);
    expect(snapshot?.resources?.inheritHostResources).toBe(false);
    expect(snapshot?.resources?.skills).toEqual([]);
    expect(snapshot?.resources?.prompts).toEqual([]);
    expect(snapshot?.resources?.themes).toEqual([]);
    expect(snapshot?.resources?.contextFiles).toEqual([]);
    expect(snapshot?.resources?.agentDir).toBe(join(open.cwd, ".sprout-pi"));
    expect(snapshot?.resources?.hostAgentDir).toBe(open.agentDir);
  });

  it("显式打开：open 传 true，快照保留宿主 skills 与 prompt templates", async () => {
    const { open, snapshot } = await runWithSwitch(true);
    expect(open.inheritHostResources).toBe(true);
    expect(snapshot?.resources?.inheritHostResources).toBe(true);
    expect(snapshot?.resources?.skills).toEqual(["host-skill"]);
    expect(snapshot?.resources?.prompts).toEqual(["host-prompt"]);
    // 打开开关不搬 themes 与 context files。
    expect(snapshot?.resources?.themes).toEqual([]);
    expect(snapshot?.resources?.contextFiles).toEqual([]);
  });

  it("显式关闭的值不会被当成 true，协议保留 registry 与资源段", async () => {
    const { open, snapshot } = await runWithSwitch(false);
    expect(open.inheritHostResources).toBe(false);
    expect(snapshot?.resources?.inheritHostResources).toBe(false);
    expect(snapshot?.registeredTools).toEqual(["bash", "edit", "read", "sprout_status", "write"]);
    expect(snapshot?.tools).toEqual(["bash", "edit", "read", "write"]);
  });
});
