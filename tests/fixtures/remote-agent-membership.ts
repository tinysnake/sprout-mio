// LIVE-01/02：真实 runtime、SQLite、域入口与网关；只替换 Pi 子进程，不调用模型。
import assert from "node:assert/strict";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { agentRun, diagnosticEvent, remoteToolGrant } from "../../src/db/schema";
import { addProjectMember, createAgentProfile, removeProjectMember } from "../../src/domain/agent";
import { abortAgentRun, getAgentRun, queuedRunWork } from "../../src/domain/agent-run";
import { createDirectChat, listChats, sendMessage } from "../../src/domain/chat";
import { createProject } from "../../src/domain/project";
import { issueRemoteToolGrant, revokeRemoteToolGrant } from "../../src/server/remote-agent-gateway";
import type { PiSessionProcess } from "../../src/server/pi-host/process";
import { executeRun } from "../../src/server/pi-host/run";
import { machineRuntimeContext, shutdownRuntime, startRuntime } from "../../src/server/runtime";

await startRuntime();
try {
  const userId = "usr_remote_membership";
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(userId, "Grant", "grant@channel.test");
  const ctx = { userId, requestId: newId(ID_PREFIXES.request) };
  const project = createProject({ name: "Remote membership" }, ctx);
  const agent = createAgentProfile({ name: "GrantAgent", persona: "", harness: "pi" }, ctx);
  addProjectMember(project.id, agent.id, ctx);
  const channel = listChats(project.id, ctx).find((entry) => entry.kind === "public_channel")!;
  const dm = createDirectChat(project.id, agent.id, ctx).chat;
  const runtime = { ...(await machineRuntimeContext()), requestId: ctx.requestId };
  const runner = { pid: process.pid } as PiSessionProcess;
  const runs = [];
  for (const chat of [channel, dm]) {
    sendMessage(chat.id, { senderKind: "human", senderId: userId, body: "@GrantAgent hello" }, ctx);
    const work = queuedRunWork().find((entry) => entry.run.chatId === chat.id)!;
    assert(work, `${chat.kind} queued run`);
    if (chat.kind === "public_channel") {
      assert.equal(
        (
          sqlite.prepare("SELECT count(*) AS n FROM chat_member WHERE chat_id=?").get(chat.id) as {
            n: number;
          }
        ).n,
        0,
      );
    }
    const grant = issueRemoteToolGrant(work.run.id, runner, runtime);
    assert.equal(grant.projectId, project.id);
    assert.equal(
      db.select().from(remoteToolGrant).where(eq(remoteToolGrant.runId, work.run.id)).get()
        ?.revokedAt,
      null,
    );
    revokeRemoteToolGrant(work.run.id, runtime);
    abortAgentRun(work.run.id, ctx);
    runs.push(db.select().from(agentRun).where(eq(agentRun.id, work.run.id)).get()!);
    console.log(`PASS remote-grant.${chat.kind}.current-member ${work.run.id}`);
  }
  removeProjectMember(project.id, agent.id, ctx);
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) AS n FROM chat_member WHERE chat_id=? AND member_id=?")
        .get(dm.id, agent.id) as { n: number }
    ).n,
    1,
    "DM 历史实体成员仍在",
  );
  for (const original of runs) {
    // 模拟成员移除后迟到的调度。保持 queued + 活 runtime，排除终态 run/失效进程掩盖资格判定。
    const id = newId(ID_PREFIXES.run);
    db.insert(agentRun)
      .values({ ...original, id, status: "queued", settledAt: null })
      .run();
    assert.throws(() => issueRemoteToolGrant(id, runner, runtime), { code: "remote_run_inactive" });
    assert.equal(
      db.select().from(remoteToolGrant).where(eq(remoteToolGrant.runId, id)).get(),
      undefined,
    );
    abortAgentRun(id, ctx);
    console.log(
      `PASS remote-grant.${original.chatId === dm.id ? "dm" : "public_channel"}.removed-member ${id}`,
    );
  }

  // 未知基础设施异常的详细原因留在服务日志和 diagnostic_event，对外仍是既有文案。
  addProjectMember(project.id, agent.id, ctx);
  sendMessage(
    channel.id,
    { senderKind: "human", senderId: userId, body: "@GrantAgent fail open" },
    ctx,
  );
  const work = queuedRunWork().find((entry) => entry.run.chatId === channel.id)!;
  const failure = Object.assign(new Error("fixture runner open unavailable"), {
    name: "FixtureOpenError",
    code: "fixture_open_failed",
    secret: "must-not-be-logged",
  });
  const disposed: (() => void)[] = [];
  const failingRunner = {
    pid: process.pid,
    onDispose: (callback: () => void) => disposed.push(callback),
    open: async () => {
      throw failure;
    },
    close: async () => {
      for (const callback of disposed.splice(0)) callback();
    },
  } as unknown as PiSessionProcess;
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => {
    logs.push(args);
    originalError(...args);
  };
  try {
    await Effect.runPromise(executeRun(work, failingRunner, { isStopping: () => false }));
  } finally {
    console.error = originalError;
  }
  const failed = getAgentRun(work.run.id, ctx);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "run_failed");
  assert.equal(failed.errorMessage, "Agent run 执行失败");
  const diagnostic = db
    .select()
    .from(diagnosticEvent)
    .all()
    .find(
      (row: typeof diagnosticEvent.$inferSelect) =>
        row.runId === failed.id && row.event === "pi_host.run_failed",
    );
  assert(diagnostic, "原始失败进入 diagnostic_event");
  assert.equal(diagnostic.requestId, work.run.requestId);
  assert.equal(diagnostic.projectId, project.id);
  assert.equal(diagnostic.chatId, channel.id);
  assert.equal(diagnostic.instanceId, work.run.instanceId);
  assert.deepEqual(JSON.parse(diagnostic.data!), {
    errorName: "FixtureOpenError",
    errorCode: "fixture_open_failed",
    cause: "fixture runner open unavailable",
  });
  assert.match(JSON.stringify(logs), /fixture_open_failed/);
  assert.match(JSON.stringify(logs), /fixture runner open unavailable/);
  assert(!JSON.stringify(logs).includes("must-not-be-logged"));
  assert(!diagnostic.data!.includes("must-not-be-logged"));
  assert(
    db.select().from(remoteToolGrant).where(eq(remoteToolGrant.runId, failed.id)).get()?.revokedAt,
  );
  console.log(`PASS pi-host.failure-cause ${failed.id}`);
} finally {
  await shutdownRuntime("remote-membership-fixture");
}
