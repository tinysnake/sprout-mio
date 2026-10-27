// 真实 SQLite + 真实 Web 边界：人类取消的归属、幂等、拒绝路径与 0015 迁移数据拷贝。
// 会话 cookie、私有库与命令正文都留在 mktemp。
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { executionCancellationViewSchema, executionViewSchema } from "../../src/contracts/remote";
import type { RemoteCommand } from "../../src/contracts/remote";
import { sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { auth } from "../../src/lib/auth";
import { acquireLease, releaseLease } from "../../src/server/lease";
import {
  cancelExecution,
  enqueueCancellation,
  getExecution,
  listProjectExecutions,
  requestExecution,
} from "../../src/server/remote";
import {
  cancelExecutionBoundary,
  readExecutionLogBoundary,
} from "../../src/server/functions/remote";
import { runtimeSnapshot, startRuntime } from "../../src/server/runtime";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";

migrateDatabase();
await startRuntime();
const bootId = runtimeSnapshot().bootId!;
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const req = () => newId(ID_PREFIXES.request);
const fail = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;

const signUp = async (tag: string) => {
  const result = await auth.api.signUpEmail({
    body: { email: `${tag}-${Date.now()}@example.test`, password: "fixture-password-1", name: tag },
    returnHeaders: true,
  });
  const cookie = result.headers.get("set-cookie")!.split(";")[0]!;
  return { headers: new Headers({ cookie }), userId: result.response.user.id };
};
const owner = await signUp("cancel-owner");
const stranger = await signUp("cancel-stranger");
const noCookie = new Headers();

type Results = Parameters<typeof exchangeWorker>[0]["remote"]["results"];
const identityOf = (command: RemoteCommand) => {
  const {
    operation: _operation,
    requestId: _requestId,
    dispatchDeadlineAt: _deadline,
    directoryRevision: _directory,
    runtimeDeadlineAt: _runtime,
    maxRuntimeMs: _max,
    runnerToken: _token,
    ...identity
  } = command;
  return identity;
};

/** 一个租户：自己的 Project、Machine、绑定、租约、真 Worker 会话。 */
function tenant(userId: string, label: string) {
  const ctx = { userId, requestId: req(), bootId, now: new Date() };
  const projectId = newId(ID_PREFIXES.project);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,?,?)")
    .run(projectId, label, userId);
  const machine = createMachine({ name: `${label} Mac` }, ctx);
  const machineId = machine.detail.machine.id;
  saveProjectMachineBinding(
    { projectId, machineId, description: "fixture", expectedRevision: null },
    ctx,
  );
  const actor = seedRemoteActor(sqlite, userId, projectId, bootId);
  const key = { projectId, machineId };
  acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, actor);
  const secret = randomBytes(32).toString("base64url");
  const wire = { machineId, secret, version: 3 as const, requestId: req() };
  enrollWorker({ ...wire, ticket: machine.ticket }, actor);
  const session = openWorker({ ...wire, attemptId: randomUUID() }, actor).session;
  let seq = 0;
  const exchange = (results: Results = []) =>
    exchangeWorker(
      {
        version: 3,
        requestId: wire.requestId,
        secret,
        session,
        seq: ++seq,
        mode: "normal",
        capability: {
          platform: "darwin",
          arch: "arm64",
          workerVersion: "test",
          shells: [
            {
              path: "/bin/sh",
              kind: "sh",
              version: null,
              checkedAt: ctx.now.toISOString(),
              probe: { kind: "success" },
            },
          ],
          remoteOperations: ["shell"],
        },
        observations: [],
        remote: { results, fenceAcks: [], mcp: [], mcpCursors: [] },
      },
      // 每次 exchange 都取自当前时钟：宿主不会用种子时刻给送达时间盖章。
      { ...actor, now: new Date() },
    );
  const submit = (generation = 1) =>
    requestExecution(
      {
        ...key,
        requestId: req(),
        authorizationGeneration: generation,
        operation: { kind: "shell", command: "sleep 30", cwd: "/tmp", waitMs: 1000 },
      },
      actor,
    );
  return { key, actor, ctx, exchange, submit, secret, wire, session };
}

const own = tenant(owner.userId, "Owner");
const human = { ...own.ctx, userId: owner.userId };
const foreign = tenant(stranger.userId, "Stranger");
own.exchange();
foreign.exchange();
const foreignExecution = foreign.submit();
foreign.exchange();

const running = own.submit();
own.exchange();
const sibling = own.submit();
own.exchange();
assert.equal(
  getExecution({ ...own.key, executionId: running.executionId }, own.ctx).state,
  "dispatched",
);
const viewBefore = getExecution({ ...own.key, executionId: running.executionId }, human);
assert(executionViewSchema.safeParse(viewBefore).success);
assert.equal(viewBefore.cancellation, null);
pass("没有取消记录时 executionView().cancellation 为 null");

// 1. 人类取消成功：actor 归属人类，幂等键按人命名，重放不新增行。
const cancelInput = { executionId: running.executionId, requestId: req() };
const cancelled = await cancelExecutionBoundary(cancelInput, owner.headers, req());
assert(cancelled.ok, JSON.stringify(cancelled));
assert(executionCancellationViewSchema.safeParse(cancelled.data).success);
assert.equal(cancelled.data.state, "requested");
const row = sqlite
  .prepare(
    "SELECT actor_kind, actor_id, request_id, state FROM execution_cancellation WHERE id = ?",
  )
  .get(cancelled.data.cancelId) as {
  actor_kind: string;
  actor_id: string;
  request_id: string;
  state: string;
};
assert.equal(row.actor_kind, "human");
assert.equal(row.actor_id, owner.userId);
assert.equal(row.state, "requested");
assert.match(row.request_id, new RegExp(`^cancel:human:${owner.userId}:req_`));
const replay = await cancelExecutionBoundary(cancelInput, owner.headers, req());
assert(replay.ok);
assert.equal(replay.data.cancelId, cancelled.data.cancelId);
const rowCount = () =>
  (sqlite.prepare("SELECT COUNT(*) AS n FROM execution_cancellation").get() as { n: number }).n;
assert.equal(rowCount(), 1);
pass("人类取消落库为 actor_kind='human'，幂等键按人类身份命名，同 requestId 重放返回同一记录");

// 9. 读视图带取消事实，但执行本身仍是 dispatched：取消不是终态。
const viewAfter = getExecution({ ...own.key, executionId: running.executionId }, human);
assert(executionViewSchema.safeParse(viewAfter).success);
assert.equal(viewAfter.cancellation?.cancelId, cancelled.data.cancelId);
assert.equal(viewAfter.state, "dispatched");
const listed = listProjectExecutions({ projectId: own.key.projectId }, human);
assert.equal(
  listed.find((execution) => execution.executionId === running.executionId)?.cancellation?.cancelId,
  cancelled.data.cancelId,
);
pass("executionView 与 listProjectExecutions 带出取消事实，执行状态不被取消改写");

// 2. 同一 requestId 换 executionId 是冲突，不是新请求。
assert.throws(
  () =>
    cancelExecution({ executionId: sibling.executionId, requestId: cancelInput.requestId }, human),
  fail("remote_request_conflict"),
);
pass("反证：同一 requestId 换 executionId 被拒为 remote_request_conflict");

// 5. 已有未完成意图时不得再入队新意图。
assert.throws(
  () => cancelExecution({ executionId: running.executionId, requestId: req() }, human),
  fail("cancellation_delivery_unconfirmed"),
);
assert.equal(rowCount(), 1);
pass("反证：已有 open 取消意图时新请求报 delivery_unconfirmed，不写第二行");

// 3. 边界授权：未登录、跨用户、他人 Project/Machine。
const unauth = await cancelExecutionBoundary(cancelInput, noCookie, req());
assert.equal(unauth.ok, false);
assert.equal(!unauth.ok && unauth.error.code, "unauthorized");
const unauthRead = await readExecutionLogBoundary(
  { ...own.key, executionId: running.executionId, cursor: null, limitBytes: 65536 },
  noCookie,
  req(),
);
assert.equal(unauthRead.ok, false);
assert.equal(!unauthRead.ok && unauthRead.error.code, "unauthorized");
assert.throws(() => cancelExecution(cancelInput, { ...own.ctx, userId: "" }), fail("unauthorized"));
pass("反证：无 session cookie 与空 userId 的读取与取消都是 unauthorized");

const foreignRead = await readExecutionLogBoundary(
  { ...own.key, executionId: running.executionId, cursor: null, limitBytes: 65536 },
  stranger.headers,
  req(),
);
assert.equal(foreignRead.ok, false);
assert.equal(!foreignRead.ok && foreignRead.error.code, "not_found");
const foreignCancel = await cancelExecutionBoundary(cancelInput, stranger.headers, req());
assert.equal(foreignCancel.ok, false);
assert.equal(!foreignCancel.ok && foreignCancel.error.code, "not_found");
assert.throws(
  () => cancelExecution({ executionId: foreignExecution.executionId, requestId: req() }, human),
  fail("not_found"),
);
assert.throws(
  () =>
    cancelExecution(
      { executionId: "exe_00000000-0000-4000-8000-000000000000", requestId: req() },
      human,
    ),
  fail("not_found"),
);
pass("反证：另一用户的 session、他人 Project/Machine 上的执行与不存在的执行都是 not_found");

// 7. 日志读取边界：创建者拿到游标与 logState，非创建者被拒。
const ownerRead = await readExecutionLogBoundary(
  { ...own.key, executionId: running.executionId, cursor: null, limitBytes: 65536 },
  owner.headers,
  req(),
);
assert(ownerRead.ok, JSON.stringify(ownerRead));
assert.deepEqual(ownerRead.data.nextCursor, {
  executionId: running.executionId,
  nextSequence: 0,
});
assert.equal(ownerRead.data.logState, "none");
const unknownCursor = await readExecutionLogBoundary(
  {
    ...own.key,
    executionId: running.executionId,
    cursor: { executionId: running.executionId, nextSequence: 7 },
    limitBytes: 65536,
  },
  owner.headers,
  req(),
);
assert(unknownCursor.ok);
assert.deepEqual(unknownCursor.data.nextCursor, {
  executionId: running.executionId,
  nextSequence: 7,
});
assert.equal(unknownCursor.data.frames.length, 0);
assert.equal(unknownCursor.data.logState, "none");
pass("创建者经 Web boundary 读到游标与 logState，空范围不被当成有输出");

// 6. 终态执行：不可取消。
const terminal = own.submit();
const terminalCommand = own.exchange().remote.commands[0]!;
own.exchange([
  {
    ...identityOf(terminalCommand),
    phase: "terminal",
    drained: true,
    outcome: "succeeded",
    payload: {
      kind: "shell",
      pid: 4812,
      exited: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    },
  },
]);
assert.equal(
  getExecution({ ...own.key, executionId: terminal.executionId }, human).state,
  "succeeded",
);
assert.throws(
  () => cancelExecution({ executionId: terminal.executionId, requestId: req() }, human),
  fail("cancellation_already_terminal"),
);
pass("反证：终态执行拒绝取消，报 cancellation_already_terminal");

// 6. agent 路径回归：六态推进与错误码不变，只新增 actor 归属。
const agentExecution = own.submit();
const agentCommand = own.exchange().remote.commands[0]!;
const agentInput = {
  ...own.key,
  executionId: agentExecution.executionId,
  requestId: req(),
  authorizationGeneration: 1,
  policy: "kill" as const,
  termWaitMs: 500,
};
const agentCancel = enqueueCancellation(agentInput, own.actor);
assert(executionCancellationViewSchema.safeParse(agentCancel).success);
assert.equal(agentCancel.state, "requested");
assert.equal(enqueueCancellation(agentInput, own.actor).cancelId, agentCancel.cancelId);
const agentRow = sqlite
  .prepare(
    "SELECT actor_kind, actor_id, request_id, policy FROM execution_cancellation WHERE id = ?",
  )
  .get(agentCancel.cancelId) as {
  actor_kind: string;
  actor_id: string;
  request_id: string;
  policy: string;
};
assert.equal(agentRow.actor_kind, "agent");
assert.equal(agentRow.actor_id, own.actor.instanceId);
assert.match(agentRow.request_id, new RegExp(`^cancel:agent:${own.actor.instanceId}:req_`));
assert.equal(agentRow.policy, "kill");
const agentDelivered = own.exchange();
assert.equal(agentDelivered.remote.cancellations?.length, 1);
assert.equal(agentDelivered.remote.cancellations![0]!.cancelId, agentCancel.cancelId);
assert.equal(
  getExecution({ ...own.key, executionId: agentExecution.executionId }, human).state,
  "dispatched",
);
const afterDelivered = rowCount();
assert.throws(
  () => enqueueCancellation({ ...agentInput, requestId: req() }, own.actor),
  fail("cancellation_delivery_unconfirmed"),
);
assert.equal(rowCount(), afterDelivered);
own.exchange([
  {
    ...identityOf(agentCommand),
    phase: "terminal",
    drained: true,
    outcome: "succeeded",
    payload: {
      kind: "shell",
      pid: 4813,
      exited: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    },
  },
]);
assert.equal(
  getExecution({ ...own.key, executionId: agentExecution.executionId }, human).cancellation?.state,
  "exited_observed",
);
assert.throws(
  () => enqueueCancellation({ ...agentInput, requestId: req() }, own.actor),
  fail("cancellation_already_terminal"),
);
pass("agent 路径六态与错误码不变：requested→delivered→exited_observed，actor 归属发起分身");

// 4. 收回后代次前进与租约释放两种情况都不得投递，且库中不留新行。
const stale = own.submit();
own.exchange();
const beforeStale = rowCount();
releaseLease({ ...own.key, action: "release", requestId: req(), expectedGeneration: 1 }, own.actor);
// 租约进入 fencing：没有仍被授权的投递通道。
assert.throws(
  () => cancelExecution({ executionId: stale.executionId, requestId: req() }, human),
  fail("cancellation_delivery_unconfirmed"),
);
assert.equal(rowCount(), beforeStale);
// 收回完成后代次前进到 2，旧的 gen 1 执行仍然不可取消。收回的两阶段由宿主完成，
// 这里直接落它写下的同形状租约事实：旧授权 revoked、新一代 active、租约代次 +1。
const advanced = new Date();
sqlite
  .prepare(
    "UPDATE lease_authorization SET state = 'revoked', revoked_at = ? WHERE project_id = ? AND machine_id = ? AND generation = 1",
  )
  .run(advanced.getTime(), own.key.projectId, own.key.machineId);
sqlite
  .prepare(
    `INSERT INTO lease_authorization
       (project_id, machine_id, generation, holder_instance_id, state, issued_at, revoked_at, reason)
     VALUES (?, ?, 2, ?, 'active', ?, NULL, 'reclaim')`,
  )
  .run(own.key.projectId, own.key.machineId, own.actor.instanceId, advanced.getTime());
sqlite
  .prepare(
    "UPDATE machine_lease SET generation = 2, state = 'held', holder_instance_id = ?, changed_at = ? WHERE project_id = ? AND machine_id = ?",
  )
  .run(own.actor.instanceId, advanced.getTime(), own.key.projectId, own.key.machineId);
assert.throws(
  () => cancelExecution({ executionId: stale.executionId, requestId: req() }, human),
  fail("cancellation_delivery_unconfirmed"),
);
assert.equal(rowCount(), beforeStale);
pass("反证：租约释放后与收回后旧代次的取消都报 delivery_unconfirmed，不写新行也不伪装成已入队");

// 8. 数据形状：非法 actor 由 CHECK 拒绝；0015 迁移按 agent 搬运旧 actor_instance_id。
assert.throws(
  () =>
    sqlite
      .prepare("UPDATE execution_cancellation SET actor_kind = 'system' WHERE id = ?")
      .run(cancelled.data.cancelId),
  /CHECK/,
);
assert.throws(
  () =>
    sqlite
      .prepare("UPDATE execution_cancellation SET actor_id = '' WHERE id = ?")
      .run(cancelled.data.cancelId),
  /CHECK/,
);
pass("反证：actor_kind 只接受 agent/human，actor_id 不接受空串（CHECK 11/12）");

const legacy = mkdtempSync(join(tmpdir(), "p4c-cancel-legacy-"));
try {
  const connection = new Database(join(legacy, "legacy.sqlite"));
  const entries = JSON.parse(readFileSync(join("drizzle", "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const fileOf = (index: number) => {
    const padded = String(index).padStart(4, "0");
    return `${entries.entries.find((entry) => entry.tag.startsWith(`${padded}_`))!.tag}.sql`;
  };
  const apply = (file: string) => {
    for (const statement of readFileSync(join("drizzle", file), "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) connection.exec(statement);
  };
  for (let index = 0; index <= 14; index += 1) apply(fileOf(index));
  // 旧行只需形状真实：引用对象不在这个小库里，外键核对与本次断言无关。
  connection.pragma("foreign_keys = OFF");
  connection
    .prepare(
      `INSERT INTO execution_cancellation
         (id, execution_id, request_id, project_id, machine_id, authorization_generation,
          holder_instance_id, actor_instance_id, state, signal_outcome, policy, term_wait_ms,
          requested_at, delivered_at, exited_at, failure_reason)
       VALUES ('cnl_legacy', 'exe_legacy', 'cancel:instance-old:req_legacy', 'prj_legacy',
               'mch_legacy', 1, 'instance-old', 'instance-old', 'requested', 'none',
               'term_then_kill', 2000, 20, NULL, NULL, NULL)`,
    )
    .run();
  apply("0015_cancel_actor_authority.sql");
  const migrated = connection
    .prepare("SELECT actor_kind, actor_id FROM execution_cancellation WHERE id = 'cnl_legacy'")
    .get() as { actor_kind: string; actor_id: string };
  connection.close();
  assert.equal(migrated.actor_kind, "agent");
  assert.equal(migrated.actor_id, "instance-old");
  pass("0015 迁移把旧行的 actor_instance_id 原样搬进 actor_id 并标成 agent");
} finally {
  rmSync(legacy, { recursive: true, force: true });
}

console.log(`execution-cancel-authority: PASS (${checks.length} checks)`);
