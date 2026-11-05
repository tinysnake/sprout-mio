import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InfoHubHint } from "../src/contracts/info-hub-hint";

const directory = mkdtempSync(join(tmpdir(), "p6b-info-hint-"));
process.env.DATABASE_URL = join(directory, "hint.sqlite");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite, db } = await import("../src/db");
const { agentRun } = await import("../src/db/schema");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { INFO_HUB_LIMITS } = await import("../src/contracts/info-hub");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const { createDirectChat, ensureInstance } = await import("../src/domain/chat");
const { InfoHubHintChannel } = await import("../src/domain/info-hub-hint");
type ProjectContext = import("../src/domain/project").ProjectContext;

sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('usr_hint','Hint','hint@info.test',0,1,1)",
  )
  .run();

/** 连接视图的 `lastSeenAt` 来自这一列：心跳只推进它。 */
const base = Date.parse("2026-01-01T00:00:00Z");
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot (id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
const ctx = {
  userId: "usr_hint",
  requestId: newId(ID_PREFIXES.request),
  bootId,
  now: new Date(base),
} as ProjectContext & { bootId: string; now: Date };

const project = createProject({ name: "Hint Project" }, ctx);
const profile = createAgentProfile({ name: "Hint Agent", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, profile.id, ctx);
const chat = createDirectChat(project.id, profile.id, ctx).chat;
const instance = ensureInstance(chat.id, profile.id, ctx);
const run = db
  .insert(agentRun)
  .values({
    id: newId(ID_PREFIXES.run),
    instanceId: instance.id,
    chatId: chat.id,
    projectId: project.id,
    requestId: ctx.requestId,
    sessionId: instance.id,
    status: "running",
    startedAt: new Date(base),
  })
  .returning()
  .get();

const machineId = newId(ID_PREFIXES.machine);
sqlite
  .prepare(
    "INSERT INTO machine (id,name,root_directory,root_revision,created_by,created_at,updated_at) VALUES (?,?,NULL,1,?,?,?)",
  )
  .run(machineId, "Hint Machine", ctx.userId, base, base);
sqlite
  .prepare(
    "INSERT INTO project_machine (project_id,machine_id,created_by,description,revision,created_at,updated_at) VALUES (?,?,?,'',1,?,?)",
  )
  .run(project.id, machineId, ctx.userId, base, base);
sqlite
  .prepare(
    "INSERT INTO machine_lease (project_id,machine_id,generation,state,holder_instance_id,changed_at) VALUES (?,?,1,'held',?,?)",
  )
  .run(project.id, machineId, instance.id, base);
const CAPABILITY = JSON.stringify({
  version: 1,
  platform: "darwin",
  arch: "arm64",
  workerVersion: "test",
  shells: [],
  remoteOperations: [],
});
const openConnection = (generation: number, lastSeenAt: number) =>
  sqlite
    .prepare(
      "INSERT INTO machine_connection (machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at,seq,capability,last_payload_hash) VALUES (?,?,?,?,'open',?,?,1,?,?)",
    )
    .run(
      machineId,
      generation,
      `attempt-${generation}`,
      bootId,
      lastSeenAt,
      lastSeenAt,
      CAPABILITY,
      "a".repeat(64),
    );
const heartbeat = (generation: number, lastSeenAt: number) =>
  sqlite
    .prepare("UPDATE machine_connection SET last_seen_at=? WHERE machine_id=? AND generation=?")
    .run(lastSeenAt, machineId, generation);
const closeConnection = (generation: number, at: number) =>
  sqlite
    .prepare(
      "UPDATE machine_connection SET status='closed', closed_at=?, last_seen_at=? WHERE machine_id=? AND generation=?",
    )
    .run(at, at, machineId, generation);
openConnection(1, base);

/** 合并窗口从契约读，不把 2s 写死在断言里；最小间隔另有一条断言钉住 60 秒。 */
const sendAfterMergeWindow = async (
  channel: InstanceType<typeof InfoHubHintChannel>,
  detectAt: number,
) => {
  await channel.tick(detectAt);
  await channel.tick(detectAt + INFO_HUB_LIMITS.hintMergeWindowMs);
};

function track() {
  const delivered: InfoHubHint[] = [];
  const channel = new InfoHubHintChannel(run.id, ctx, (hint) => {
    delivered.push(hint);
  });
  return { delivered, channel };
}

afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("运行中 Info Hub 提示的变化指纹", () => {
  it("只有连接 lastSeenAt 的推进不产生提示", async () => {
    const { delivered, channel } = track();
    heartbeat(1, base + 1_000);
    await channel.tick(base + 1_000);
    heartbeat(1, base + 3_000);
    await channel.tick(base + 3_000);
    // 跨过合并窗口和最小间隔后依然没有待发变化。
    heartbeat(1, base + 9_000);
    await channel.tick(base + 9_000);
    expect(delivered).toEqual([]);
  });

  it("连接代次变化仍产生提示，之后的心跳不再重复提示", async () => {
    const { delivered, channel } = track();
    openConnection(2, base + 10_000);
    await sendAfterMergeWindow(channel, base + 10_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.changes).toEqual([{ kind: "machine_connection", machineId }]);
    heartbeat(2, base + 20_000);
    await channel.tick(base + 20_000);
    heartbeat(2, base + 26_000);
    await channel.tick(base + 26_000);
    expect(delivered).toHaveLength(1);
  });

  it("online→offline 的 kind 变化仍产生提示", async () => {
    const { delivered, channel } = track();
    closeConnection(2, base + 30_000);
    await sendAfterMergeWindow(channel, base + 30_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.changes).toEqual([{ kind: "machine_connection", machineId }]);
  });
});

describe("提示的投递节拍与 run 边界", () => {
  it("两次提示至少相隔一个最小间隔（60s），中间的真实变化合并到后一条", async () => {
    // 60 秒是产品决定（用户要求「一般 60s 发送 agent 一次」），不是实现自由参数。
    expect(INFO_HUB_LIMITS.hintMinimumIntervalMs).toBe(60_000);
    const { delivered, channel } = track();
    openConnection(3, base + 60_000);
    await sendAfterMergeWindow(channel, base + 60_000);
    expect(delivered).toHaveLength(1);
    const sentAt = base + 60_000 + INFO_HUB_LIMITS.hintMergeWindowMs;
    // 投递后 1 秒又出现真实变化：它得等到最小间隔，而不是立刻再发一条。
    closeConnection(3, sentAt + 1_000);
    await channel.tick(sentAt + 1_000);
    await channel.tick(sentAt + 1_000 + INFO_HUB_LIMITS.hintMergeWindowMs);
    expect(delivered).toHaveLength(1);
    await channel.tick(sentAt + INFO_HUB_LIMITS.hintMinimumIntervalMs - 1);
    expect(delivered).toHaveLength(1);
    await channel.tick(sentAt + INFO_HUB_LIMITS.hintMinimumIntervalMs);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.changes).toEqual([{ kind: "machine_connection", machineId }]);
  });

  it("run 结算后已发现的待发变化不再投递", async () => {
    const { delivered, channel } = track();
    openConnection(4, base + 180_000);
    await channel.tick(base + 180_000);
    expect(delivered).toEqual([]);
    channel.dispose();
    await channel.tick(base + 180_000 + INFO_HUB_LIMITS.hintMergeWindowMs);
    await channel.tick(base + 180_000 + INFO_HUB_LIMITS.hintMinimumIntervalMs);
    expect(delivered).toEqual([]);
  });

  it("run 不再是 running 时提示停止，不在工作结束后补发", async () => {
    const { delivered, channel } = track();
    openConnection(5, base + 300_000);
    await channel.tick(base + 300_000);
    expect(delivered).toEqual([]);
    sqlite
      .prepare("UPDATE agent_run SET status='interrupted', settled_at=? WHERE id=?")
      .run(base + 300_000, run.id);
    await channel.tick(base + 300_000 + INFO_HUB_LIMITS.hintMergeWindowMs);
    await channel.tick(base + 300_000 + INFO_HUB_LIMITS.hintMinimumIntervalMs);
    expect(delivered).toEqual([]);
  });
});
