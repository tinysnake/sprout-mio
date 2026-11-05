import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ProjectContext } from "../src/domain/access";

/**
 * 通知投递确认只认 runner 的 `input_delivered`。prod run_16d68a18 里宿主在写入 steer 的同一刻
 * 就把 `delivered_at` 记上，runner 回 `input_rejected`（会话不在运行）时那条通知其实没进模型，
 * 却再也不会重投。这里用线上协议证明：被拒后保持 pending 并退避重试，确认后才落库。
 */
const directory = mkdtempSync(join(tmpdir(), "pi-host-notices-"));
process.env.DATABASE_URL = join(directory, "notices.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite, db } = await import("../src/db");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const runs = await import("../src/domain/agent-run");
const { startRuntime, shutdownRuntime } = await import("../src/server/runtime");
const { PiSessionProcess } = await import("../src/server/pi-host/process");
const { executeRun } = await import("../src/server/pi-host/run");
const { insertRevokeNotice, pendingRunNotices } = await import("../src/server/notices");

const ctx: ProjectContext = {
  userId: "notice-human",
  requestId: newId(ID_PREFIXES.request),
};
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(ctx.userId, ctx.userId, "notice@test.example");
const project = createProject({ name: "Notice" }, ctx);
const profile = createAgentProfile({ name: "Notice Agent", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, profile.id, ctx);

/** 通知的 (project, machine) 外键要求这条关系存在；租约本身不参与投递判定。 */
const machineId = newId(ID_PREFIXES.machine);
sqlite
  .prepare(
    "INSERT INTO machine (id,name,root_directory,root_revision,created_by,created_at,updated_at) VALUES (?,?,NULL,1,?,1,1)",
  )
  .run(machineId, "Notice Machine", ctx.userId);
sqlite
  .prepare(
    "INSERT INTO project_machine (project_id,machine_id,created_by,description,revision,created_at,updated_at) VALUES (?,?,?,'',1,1,1)",
  )
  .run(project.id, machineId, ctx.userId);

/**
 * 只走线上协议的 runner：`open` 回 ready，`prompt` 挂 2.5 秒才收尾，给通知重试留出两次
 * 尝试的窗口；`steer` 按模式回 `input_rejected` 或 `input_delivered`。
 */
function writeRunner(mode: "accept-on-retry" | "reject-always", trace: string) {
  const runnerPath = join(directory, `${mode}-runner.mjs`);
  writeFileSync(
    runnerPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const trace = (line) => appendFileSync(${JSON.stringify(trace)}, line + '\\n');
let steers = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.type === 'close') process.exit(0);
  if (command.type === 'open') {
    out({
      type: 'ready',
      id: command.id,
      snapshot: {
        provider: 'notice-test',
        model: 'none',
        thinking: 'off',
        tools: ['read'],
        registeredTools: ['read'],
        extensions: [],
        sessionId: command.sessionId,
        sessionFile: command.sessionDirectory + '/notice.jsonl',
        cwd: command.cwd,
        sdkVersion: 'notice-test',
        resources: {
          inheritHostResources: false,
          agentDir: command.cwd + '/.sprout-pi',
          hostAgentDir: command.agentDir,
          skillPaths: [],
          promptPaths: [],
          skills: [],
          prompts: [],
          themes: [],
          contextFiles: [],
          systemPromptChars: 0,
        },
        profile: command.profile,
      },
    });
    return;
  }
  if (command.type === 'prompt') {
    setTimeout(
      () => out({ type: 'settled', id: command.id, text: '已按提示调整', stopReason: 'stop' }),
      2500,
    );
    return;
  }
  if (command.type === 'steer') {
    steers += 1;
    trace('steer ' + command.messageId);
    const accepted = mode === 'accept-on-retry' && steers > 1;
    out(
      accepted
        ? { type: 'input_delivered', id: command.id, messageId: command.messageId }
        : {
            type: 'input_rejected',
            id: command.id,
            messageId: command.messageId,
            reason: 'Pi 会话当前不在运行，消息未进入本轮',
          },
    );
  }
});
`,
  );
  return runnerPath;
}

type NoticeRow = { delivered_at: number | null };

/** 一个带未投递通知的 queued run，用 runner 跑完一轮，返回 trace 与落库的通知行。 */
async function runScenario(mode: "accept-on-retry" | "reject-always") {
  const trace = join(directory, `${mode}.jsonl`);
  writeFileSync(trace, "");
  const runnerPath = writeRunner(mode, trace);
  const direct = chats.createDirectChat(project.id, profile.id, ctx);
  chats.sendMessage(
    direct.chat.id,
    { senderKind: "human", senderId: ctx.userId, body: "notice input" },
    ctx,
  );
  const queued = runs
    .listAgentRuns(direct.chat.id, ctx)
    .find((entry) => entry.status === "queued")!;
  insertRevokeNotice(db, {
    key: { projectId: project.id, machineId },
    kind: "lease_released",
    causeId: newId(ID_PREFIXES.leaseMutation),
    generation: 1,
    revocation: "confirmed",
    executions: [],
    holderInstanceId: queued.instanceId,
    now: new Date(),
  });
  const work = runs.queuedRunWork().find((entry) => entry.run.id === queued.id)!;
  const transport = new PiSessionProcess(queued.id, runnerPath);
  try {
    await Effect.runPromise(
      executeRun(work, transport, { isStopping: () => false }) as Effect.Effect<void>,
    );
  } finally {
    await transport.close();
  }
  const notice = sqlite
    .prepare("SELECT delivered_at FROM run_resource_notice WHERE run_id=?")
    .get(queued.id) as NoticeRow;
  return { runId: queued.id, notice, steers: readFileSync(trace, "utf8").trim().split("\n") };
}

await startRuntime();
afterAll(async () => {
  await shutdownRuntime("pi-host-notice-delivery-test");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("通知投递只以 runner 确认为准", () => {
  it("被拒的通知保持 pending，退避后重投，确认才落 delivered_at", async () => {
    const { runId, notice, steers } = await runScenario("accept-on-retry");
    // 第一次被拒、第二次被接受：至少两次写入，且最终落库。
    expect(steers.length).toBeGreaterThanOrEqual(2);
    expect(notice.delivered_at).not.toBeNull();
    expect(pendingRunNotices({ runId }, ctx)).toHaveLength(0);
  });

  it("始终被拒的通知不算已送达：delivered_at 保持空，仍能被下一轮拉到", async () => {
    const { runId, notice, steers } = await runScenario("reject-always");
    // 重试确实发生过，而不是被静默丢弃。
    expect(steers.length).toBeGreaterThanOrEqual(2);
    expect(notice.delivered_at).toBeNull();
    expect(pendingRunNotices({ runId }, ctx)).toHaveLength(1);
  });
});
