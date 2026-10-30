// I-P4c 退出托管门禁：真实 SQLite + 真实领域边界 + 真实 Worker outbox + 真实子进程与真实 runner。
//
// 冻结设计的可执行版本：runner 是独立观察者，命令在自己的进程组里；Worker 的取消/超时信号
// 只打命令组，runner 活到把 result.json 落盘。于是：
//   - 取消（尊重 TERM 与忽略 TERM 各一）→ 取消 `exited_observed`，执行终态与结果由 durable
//     result 落定，命令组没有残留（含 `&` 起的后台子进程）。
//   - 运行上限到点且命令不响应 TERM → 执行 `timed_out` / `failureReason='deadline'`。
//   - runner 也死了（这里确定性地由命令杀掉自己的观察者）→ 执行 `unknown:child-exited-without-result`，
//     取消 `failed/exit_not_observed`。未确认态没有被整体删掉。
// 终态 ACK 之后 Worker 会清掉 outbox（claim / runner / result 一起走），所以 durable 事实在
// `accept` 之前快照，断言读快照；这不是为了绕过删文件，而是因为「已交代完」本来就该删。
// 私有库、runner token、state-dir 与命令正文都留在 mktemp，不进日志。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionCancellationView } from "../../src/contracts/remote";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import { acquireLease } from "../../src/server/lease";
import { enqueueCancellation, getExecution, requestExecution } from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { ExecutionRegistry, ExecutionStore } from "../../src/worker/executions";
import { RemoteDispatcher } from "../../src/worker/remote";
import { seedRemoteActor } from "./remote-actors";

migrateDatabase();
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','owner','owner@example.test',0,1,1)",
  )
  .run();
const projectId = newId(ID_PREFIXES.project);
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'ExitCustody','owner')")
  .run(projectId);

const holder = seedRemoteActor(sqlite, "owner", projectId, bootId);
const machine = createMachine({ name: "ExitCustody Mac" }, holder);
const machineId = machine.detail.machine.id;
saveProjectMachineBinding(
  { projectId, machineId, description: "fixture", expectedRevision: null },
  holder,
);
const key = { projectId, machineId };
const req = () => newId(ID_PREFIXES.request);
const suspend = (ms: number) => new Promise((done) => setTimeout(done, ms));
const stateDirectory = mkdtempSync(join(tmpdir(), "p4c-exit-custody-state-"));

acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, holder);
const generation = 1;
const secret = "d".repeat(43);
const wire = { machineId, secret, version: 3 as const, requestId: req() };
enrollWorker({ ...wire, ticket: machine.ticket }, holder);
const session = openWorker({ ...wire, attemptId: randomUUID() }, holder).session;
let seq = 0;
const capability = {
  platform: "darwin" as const,
  arch: "arm64" as const,
  workerVersion: "test",
  shells: [
    {
      path: "/bin/sh",
      kind: "sh" as const,
      version: null,
      checkedAt: holder.now.toISOString(),
      probe: { kind: "success" as const },
    },
  ],
  remoteOperations: ["shell" as const],
};
const exchange = (remote: Record<string, unknown> = {}) => {
  const used = ++seq;
  const response = exchangeWorker(
    {
      version: 3,
      requestId: wire.requestId,
      secret,
      session,
      seq: used,
      mode: "normal",
      capability,
      observations: [],
      remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [], ...remote } as never,
    },
    { ...holder, now: new Date() },
  );
  return { used, response };
};
exchange();
const executionDirectory = (executionId: string) => join(stateDirectory, "executions", executionId);
const executionFiles = (executionId: string) => {
  const directory = executionDirectory(executionId);
  return existsSync(directory) ? readdirSync(directory) : [];
};
type RunnerResult = { exitCode: number | null; signal: string | null; exitedAt: string };
const readJson = <T>(executionId: string, name: string): T | null => {
  const path = join(executionDirectory(executionId), name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
};
/** durable 事实在终态 ACK 之前快照：runner 落盘的 result 才是取消与限时的唯一退出证据。 */
const watched = new Set<string>();
const durableResults = new Map<string, RunnerResult>();
const durableRunners = new Map<string, { pid: number; childPid: number | null }>();
function snapshotDurable() {
  for (const executionId of watched) {
    const result = readJson<RunnerResult>(executionId, "result.json");
    if (result) durableResults.set(executionId, result);
    const claim = readJson<{ pid: number; childPid: number | null }>(executionId, "runner.json");
    if (claim) durableRunners.set(executionId, claim);
  }
}
/**
 * 宿主侧目前没有 max_runtime_ms 入参（属于 p4c-tools / p4c-execution）。与真实下发的命令一样，
 * 这里只给指定执行补上运行上限两个字段；其余形状完全一致，Worker 与执行走真实路径。
 * 直接改库会被 `remote_execution_check_22` 拒绝（运行上限必须挂在已下发的行上），所以补在下行命令上。
 */
let pendingRuntime: { executionId: string; ms: number } | null = null;
function injectRuntime(response: ReturnType<typeof exchange>["response"]) {
  const pending = pendingRuntime;
  if (!pending) return;
  for (const command of response.remote.commands)
    if (command.executionId === pending.executionId) {
      command.maxRuntimeMs = pending.ms;
      command.runtimeDeadlineAt = new Date(Date.now() + pending.ms).toISOString();
      pendingRuntime = null;
    }
}
/** 一次真实往返：Worker 出站批 → 宿主领域函数 → Worker 接收宿主回复。 */
function round(worker: RemoteDispatcher) {
  const outgoing = worker.outgoing(1048576);
  const { used, response } = exchange(outgoing as never);
  snapshotDurable();
  injectRuntime(response);
  worker.accept(response, used, []);
  return response;
}
const makeDispatcher = () =>
  new RemoteDispatcher(
    session,
    capability as never,
    Date.now,
    undefined as never,
    new ExecutionRegistry(new ExecutionStore(stateDirectory), Date.now),
  );
const shell = (command: string, waitMs = 500) => ({
  kind: "shell" as const,
  command,
  cwd: "/tmp",
  waitMs,
});
const submit = (command: string, waitMs = 500) => {
  const view = requestExecution(
    {
      ...key,
      requestId: req(),
      authorizationGeneration: generation,
      operation: shell(command, waitMs),
    },
    holder,
  );
  watched.add(view.executionId);
  return view;
};
const view = (executionId: string) => getExecution({ ...key, executionId }, holder);
const runnerClaim = (executionId: string) =>
  readJson<{ pid: number; childPid: number | null }>(executionId, "runner.json");
/** 取消事实直接在真实表上读：holder 之外的读取路径与本门禁无关。 */
function cancellationOf(executionId: string): ExecutionCancellationView | null {
  const row = sqlite
    .prepare("SELECT * FROM execution_cancellation WHERE execution_id = ?")
    .get(executionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const stamp = (value: unknown) => (value === null ? null : new Date(Number(value)).toISOString());
  return {
    projectId: row.project_id as string,
    machineId: row.machine_id as string,
    cancelId: row.id as ExecutionCancellationView["cancelId"],
    executionId: row.execution_id as ExecutionCancellationView["executionId"],
    state: row.state as ExecutionCancellationView["state"],
    requestedAt: stamp(row.requested_at)!,
    deliveredAt: stamp(row.delivered_at),
    exitedAt: stamp(row.exited_at),
    signalOutcome: row.signal_outcome as ExecutionCancellationView["signalOutcome"],
    failureReason: row.failure_reason as ExecutionCancellationView["failureReason"],
  };
}
/** 边推进真实往返边等事实变化：不推 exchange，终态报告与 ACK 都不会自己到达。 */
async function pump(worker: RemoteDispatcher, condition: () => boolean, label: string, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    round(worker);
    if (condition()) return;
    await suspend(25);
  }
  throw new Error(`timeout ${label}`);
}
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** 这是内核事实而不是猜测：只要组里还有成员，组号就会出现在 ps 里。 */
function groupAlive(pgid: number) {
  const ps = spawnSync("ps", ["-axo", "pgid="], { encoding: "utf8" });
  return ps.stdout.split("\n").some((line) => line.trim() !== "" && Number(line.trim()) === pgid);
}
async function gone(pgid: number, label: string) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (!groupAlive(pgid)) return;
    await suspend(50);
  }
  throw new Error(`timeout ${label}: process group ${pgid} still has members`);
}
function enqueueCancel(executionId: string, termWaitMs = 2000) {
  return enqueueCancellation(
    {
      ...key,
      executionId,
      requestId: req(),
      policy: "term_then_kill",
      termWaitMs,
      authorizationGeneration: generation,
    },
    holder,
  );
}
async function cancelAndSettle(worker: RemoteDispatcher, executionId: string, termWaitMs = 2000) {
  enqueueCancel(executionId, termWaitMs);
  await pump(
    worker,
    () => {
      const current = cancellationOf(executionId);
      return current !== null && current.state !== "requested" && current.state !== "delivered";
    },
    "cancel settle",
  );
  return cancellationOf(executionId)!;
}
/**
 * 「命令真的跑起来了」的确定性判据：runner claim 里已经有 childPid。
 * 只看 runner.json 存在会把「runner 已起、命令还没起」的那一次 spawn 宽度当成已启动，
 * 信号就会落在旧的回退目标上。
 */
async function started(worker: RemoteDispatcher, executionId: string, label: string) {
  await pump(
    worker,
    () => {
      if (worker.registry.runs.get(executionId)?.started !== true) return false;
      if (!executionFiles(executionId).includes("runner.json")) return false;
      const claimed = runnerClaim(executionId)?.childPid;
      return claimed !== null && claimed !== undefined && claimed > 1;
    },
    label,
  );
}

// ── 1：取消尊重 TERM 的命令 → exited_observed，结果与终态由 durable result 落定 ──────────
const termWorker = makeDispatcher();
const termTarget = submit("sleep 120");
round(termWorker);
await started(termWorker, termTarget.executionId, "term target running");
const termClaim = runnerClaim(termTarget.executionId)!;
assert.ok(termClaim.childPid !== null && termClaim.childPid > 1, "runner 必须记下命令的 pid");
const termCancelled = await cancelAndSettle(termWorker, termTarget.executionId);
const termResult = durableResults.get(termTarget.executionId);
assert.ok(termResult !== undefined, "托管分离后 runner 必须落下 result.json");
assert.equal(termResult!.signal, "SIGTERM", "尊重 TERM 的命令由 TERM 结束");
assert.equal(termCancelled.state, "exited_observed");
assert.notEqual(termCancelled.exitedAt, null, "durable result 让取消能写下退出时间");
assert.equal(termCancelled.failureReason, null);
const termView = view(termTarget.executionId);
assert.equal(termView.state, "failed", "被取消的命令不是成功，也不是仍在运行");
assert.equal(termView.failureReason, "cancelled", "用户取消不是授权被撤回");
assert.equal(termView.recoveryReason, null, "有 durable result 就没有未记录原因");
await gone(termClaim.childPid!, "term cancel group");
assert.equal(pidAlive(termClaim.childPid!), false, "命令组不留孤儿");
pass("取消尊重 TERM 的命令：信号只打命令组，runner 落盘 → 取消 exited_observed 且进程组清空");

// ── 2：取消忽略 TERM 的命令 → KILL 命令组，后台子进程一起带走 ──────────────────────────
const pidDirectory = mkdtempSync(join(tmpdir(), "p4c-exit-custody-pids-"));
const shellPidFile = join(pidDirectory, "shell.pid");
const backgroundPidFile = join(pidDirectory, "background.pid");
const stubbornWorker = makeDispatcher();
const stubbornTarget = submit(
  `echo $$ > '${shellPidFile}'; trap '' TERM; sleep 300 & echo $! > '${backgroundPidFile}'; wait`,
);
round(stubbornWorker);
await started(stubbornWorker, stubbornTarget.executionId, "stubborn running");
const stubbornClaim = runnerClaim(stubbornTarget.executionId)!;
await pump(
  stubbornWorker,
  () => existsSync(shellPidFile) && existsSync(backgroundPidFile),
  "stubborn pids recorded",
);
const stubbornShellPid = Number(readFileSync(shellPidFile, "utf8"));
const stubbornBackgroundPid = Number(readFileSync(backgroundPidFile, "utf8"));
assert.equal(
  stubbornClaim.childPid,
  stubbornShellPid,
  "命令自己是进程组组长：runner 的 childPid 与命令的 $$ 必须是同一个 pid",
);
assert.equal(groupAlive(stubbornShellPid), true, "命令组在取消前必须有成员");
const stubbornCancelled = await cancelAndSettle(stubbornWorker, stubbornTarget.executionId);
const stubbornResult = durableResults.get(stubbornTarget.executionId);
assert.ok(stubbornResult !== undefined, "KILL 只打命令组，runner 必须活到落盘 result.json");
assert.equal(stubbornResult!.signal, "SIGKILL", "忽略 TERM 的命令只有 KILL 才能停下");
assert.equal(stubbornCancelled.state, "exited_observed");
assert.notEqual(stubbornCancelled.exitedAt, null);
assert.equal(stubbornCancelled.failureReason, null);
const stubbornView = view(stubbornTarget.executionId);
assert.equal(stubbornView.state, "failed");
assert.equal(stubbornView.failureReason, "cancelled");
assert.equal(stubbornView.recoveryReason, null);
// 收尸完整：组长与 `&` 起的后台子进程都不在了，进程组本身也没有成员。
await gone(stubbornShellPid, "stubborn cancel group");
assert.equal(pidAlive(stubbornShellPid), false, "命令组长必须消失");
assert.equal(pidAlive(stubbornBackgroundPid), false, "后台子进程必须一起被带走");
pass("取消忽略 TERM 的命令：KILL 命令组带走后台子进程，runner 落盘 → 取消 exited_observed");

// ── 3：运行上限到点且命令不响应 TERM → timed_out / failureReason='deadline' ──────────────
const deadlineWorker = makeDispatcher();
const deadlineTarget = submit("trap '' TERM; sleep 120", 1000);
pendingRuntime = { executionId: deadlineTarget.executionId, ms: 500 };
round(deadlineWorker);
await pump(
  deadlineWorker,
  () => view(deadlineTarget.executionId).terminalAt !== null,
  "runtime terminal",
);
const deadlineView = view(deadlineTarget.executionId);
assert.equal(deadlineView.state, "timed_out", "运行上限到点是已知限时，不是未知");
assert.equal(deadlineView.failureReason, "deadline");
assert.equal(deadlineView.recoveryReason, null);
const deadlineResult = durableResults.get(deadlineTarget.executionId);
assert.ok(deadlineResult !== undefined, "运行上限必须留下 durable result");
assert.equal(deadlineResult!.signal, "SIGKILL", "TERM 被忽略后由宽限后的 KILL 停下");
assert.equal(deadlineResult!.exitCode, null);
await gone(durableRunners.get(deadlineTarget.executionId)!.childPid!, "runtime deadline group");
pass(
  "运行上限到点且命令忽略 TERM：KILL 命令组、runner 落盘 → timed_out + failureReason='deadline'",
);

// ── 4：反证 —— runner 也死了 → 未确认是唯一诚实的终态 ────────────────────────────────
// 确定性地制造没有 result 的局面：意图送达后才让命令杀掉自己的 runner（`kill -9 $PPID`），
// 磁盘上永远不会出现 result.json。不靠宽限窗口的时序碰运气。
const absentSentinel = join(pidDirectory, "absent-runner-sentinel");
const absentReady = join(pidDirectory, "absent-runner-ready");
const absentWorker = makeDispatcher();
const absentTarget = submit(
  `trap '' TERM; printf ready > '${absentReady}'; while [ ! -f '${absentSentinel}' ]; do sleep 0.2; done; kill -9 $PPID; sleep 120`,
);
round(absentWorker);
await started(absentWorker, absentTarget.executionId, "absent runner running");
const absentClaim = runnerClaim(absentTarget.executionId)!;
await pump(absentWorker, () => existsSync(absentReady), "absent runner trap ready");
enqueueCancel(absentTarget.executionId);
await pump(
  absentWorker,
  () => cancellationOf(absentTarget.executionId)?.state === "delivered",
  "absent cancel delivered",
);
writeFileSync(absentSentinel, "go", { mode: 0o600 });
await pump(
  absentWorker,
  () => {
    const current = cancellationOf(absentTarget.executionId);
    return current !== null && current.state !== "requested" && current.state !== "delivered";
  },
  "absent cancel settle",
);
const absentCancelled = cancellationOf(absentTarget.executionId)!;
const absentView = view(absentTarget.executionId);
assert.equal(
  durableResults.get(absentTarget.executionId),
  undefined,
  "runner 缺席时磁盘上不应有 result.json",
);
assert.equal(absentView.state, "unknown");
assert.equal(absentView.recoveryReason, "child-exited-without-result");
assert.equal(absentView.failureReason, "worker_lost");
assert.equal(absentCancelled.state, "failed");
assert.equal(absentCancelled.failureReason, "exit_not_observed");
assert.equal(absentCancelled.exitedAt, null, "没有 result 时不得写「观察到退出」的时间");
const absentPayload = absentView.result as {
  kind: string;
  failureReason?: string;
  partial?: { exited?: boolean };
};
assert.equal(absentPayload.kind, "shell");
assert.equal(absentPayload.failureReason, "worker_lost");
assert.equal(absentPayload.partial?.exited, false, "没有 result 就不猜退出码");
await gone(absentClaim.childPid!, "absent runner group");
pass(
  "反证：runner 也死了（命令杀掉自己的观察者）→ unknown:child-exited-without-result，取消 failed/exit_not_observed",
);

console.log(`execution-exit-custody: PASS (${checks.length} checks)`);
rmSync(stateDirectory, { recursive: true, force: true });
rmSync(pidDirectory, { recursive: true, force: true });
