// P0 恢复承诺的 12 格矩阵：真实服务、真实 Worker、真实 SQLite、真实子进程。
// 4 种故障 × 3 种执行状态。每格都断言同一 requestId 只对应一条执行、副作用只发生一次，
// 且 unknown 必须带原因。任何一格不符即抛错，退出码非零。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionView, RemoteToolGrant } from "../../src/contracts/remote";
import { createRemoteClient } from "../../src/extension/remote-client";
import { registerRemoteTools } from "../../src/extension/remote-tools";
import type { SproutExtensionAPI, SproutToolResult } from "../../src/extension/types";

assert.equal(process.platform, "darwin", "real macOS Worker required");
for (const [path, command] of [
  [".output/server/index.mjs", ["pnpm", "build"]],
  ["dist/worker/main.js", ["pnpm", "worker:build"]],
] as const)
  if (!existsSync(path)) {
    const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
    assert.equal(result.status, 0, `${command.join(" ")} failed while restoring ${path}`);
  }

mkdirSync(".verify", { recursive: true });
const directory = mkdtempSync(resolve(".verify/aj-recovery-matrix-"));
const effectsDirectory = join(directory, "effects");
mkdirSync(effectsDirectory, { recursive: true });
const children: ReturnType<typeof spawn>[] = [];
const cells: { cell: string; expected: string; actual: string }[] = [];
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(
    `Timeout: ${message} (last read error: ${lastReadError || "none"}, last state: ${lastSeenState || "none"})`,
  );
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((res) => server.close(() => res()));
  assert.notEqual(port, 3000);
  return port;
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString("base64url");
const state = join(directory, "private-state");
const env = {
  ...process.env,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  DATABASE_URL: join(directory, "private.sqlite"),
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: secret,
  SPROUT_PI_ENABLED: "false",
  SPROUT_PI_DATA_DIR: join(directory, "private-pi"),
};
Object.assign(process.env, {
  DATABASE_URL: env.DATABASE_URL,
  APP_ORIGIN: base,
  BETTER_AUTH_SECRET: secret,
  NODE_ENV: "production",
  SPROUT_PI_ENABLED: "false",
});
function launch(args: string[], name: string, ipc = false) {
  const log = join(directory, name);
  const fd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, args, {
    env,
    stdio: ipc ? ["ignore", fd, fd, "ipc"] : ["ignore", fd, fd],
  });
  closeSync(fd);
  children.push(child);
  return child;
}
async function stop(child: ReturnType<typeof spawn> | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "owned process stop",
    20000,
  );
}
async function healthy(ms = 60000) {
  await until(
    async () => {
      try {
        return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    },
    "production health",
    ms,
  );
}
let service: ReturnType<typeof spawn> | undefined;
async function control(payload: { runId: string }) {
  assert(service?.connected, "service IPC required");
  const id = randomUUID();
  return new Promise<{ ok: boolean; grant?: RemoteToolGrant }>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("private control timeout")), 20000);
    const receive = (message: { id: string; ok: boolean; grant?: RemoteToolGrant }) => {
      if (message.id !== id) return;
      clearTimeout(timer);
      service!.off("message", receive);
      res(message);
    };
    service!.on("message", receive);
    service!.send({ id, action: "issue", ...payload });
  });
}

let tools = new Map<
  string,
  Parameters<Pick<SproutExtensionAPI, "registerTool">["registerTool"]>[0]
>();
async function call(name: string, parameters: Record<string, unknown>): Promise<SproutToolResult> {
  const tool = tools.get(name);
  assert(tool, `${name} must be registered`);
  return tool.execute(`${name}-${randomUUID()}`, parameters);
}
async function accept<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
  const result = await call(name, parameters);
  assert.notEqual(result.isError, true, `${name} rejected: ${JSON.stringify(result.details)}`);
  return result.details as T;
}
async function useIssuedGrant() {
  const issued = await control({ runId });
  assert(issued.ok && issued.grant, "real grant issued");
  tools = new Map();
  registerRemoteTools(
    { registerTool: (tool) => void tools.set(tool.name, tool) } as Pick<
      SproutExtensionAPI,
      "registerTool"
    >,
    createRemoteClient(issued.grant),
  );
}
let sqlite!: typeof import("../../src/db").sqlite;
let machineId = "";
let projectId = "";
let userId = "";
let generation = 1;
let worker: ReturnType<typeof spawn> | undefined;
let runId = "";
let instanceId = "";
let chatId = "";

async function getView(executionId: string): Promise<ExecutionView> {
  const result = await call("sprout_remote_execution_get", { machineId, executionId });
  const details = result.details as { data?: ExecutionView };
  assert(details.data, `execution_get must return a view: ${JSON.stringify(details)}`);
  return details.data;
}
/** 轮询期间允许工具面暂时拒绝（重连未完成）：异常不是事实，下一次读取才是。 */
let lastReadError = "";
let lastSeenState = "";
async function pollView(executionId: string): Promise<ExecutionView | null> {
  try {
    const current = await view(executionId);
    lastSeenState = current.state;
    return current;
  } catch (error) {
    lastReadError = error instanceof Error ? error.message : String(error);
    return null;
  }
}
async function submit(requestId: string, command: string): Promise<ExecutionView> {
  const deadline = Date.now() + 45000;
  for (;;) {
    // unknown 会让工具报 isError，但 data 仍是执行视图：重提交的断言只看视图事实。
    const result = await call("sprout_remote_shell", {
      machineId,
      requestId,
      authorizationGeneration: generation,
      command,
      cwd: directory,
      waitMs: 1000,
    });
    const details = result.details as { data?: ExecutionView; error?: { code?: string } };
    if (details.data) return details.data;
    const message = JSON.stringify(details.error ?? details);
    if (!message.includes("machine_unavailable") || Date.now() > deadline)
      throw new Error(`shell rejected: ${message}`);
    await sleep(500);
  }
}
/** 服务重启会把代理 run 标成 interrupted；工具面每次请求前把它重新激活（同一真实 run）。 */
async function withActiveRun<T>(action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60000;
  for (;;) {
    sqlite
      .prepare(
        "UPDATE agent_run SET status='running',started_at=COALESCE(started_at,?),settled_at=NULL WHERE id=?",
      )
      .run(Math.floor(Date.now() / 1000), runId);
    try {
      return await action();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(300);
    }
  }
}
async function view(executionId: string) {
  return withActiveRun(() => getView(executionId));
}
const connectionSeq = () =>
  Number(
    (
      sqlite
        .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
        .get(machineId) as { seq: number } | undefined
    )?.seq ?? 0,
  );
const generationRows = () =>
  Number(
    (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM machine_connection WHERE machine_id=?")
        .get(machineId) as { n: number }
    ).n,
  );
const effects = (marker: string) => {
  const path = join(effectsDirectory, `${marker}.log`);
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim()).length;
};
const claimPath = (executionId: string) => join(state, "executions", executionId, "claim.json");
const resultPath = (executionId: string) => join(state, "executions", executionId, "result.json");
/** P0 的「机器全灭」口径：runner 与命令所在的整个进程组一起消失。 */
function killExecutionGroup(executionId: string) {
  if (!existsSync(claimPath(executionId))) return;
  const claim = JSON.parse(readFileSync(claimPath(executionId), "utf8")) as { pid: number };
  // 托管分离后 runner 与命令在两个进程组：机器全灭要两个组都打，否则命令会被留成孤儿。
  const runnerPath = join(state, "executions", executionId, "runner.json");
  const runnerClaim = existsSync(runnerPath)
    ? (JSON.parse(readFileSync(runnerPath, "utf8")) as { childPid?: number | null })
    : null;
  for (const pid of [claim.pid, runnerClaim?.childPid ?? 0]) {
    if (!pid) continue;
    const ps = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
    const pgid = Number(ps.stdout.trim());
    if (!Number.isSafeInteger(pgid) || pgid <= 1) continue;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 进程组已经消失即目标状态。
    }
  }
}
async function startWorker() {
  worker = launch(["dist/worker/main.js", "run", "--state-dir", state], `worker-${Date.now()}.log`);
  const before = connectionSeq();
  const generations = generationRows();
  await until(() => generationRows() > generations, "Worker enrolled a new connection");
  return before;
}
async function stopWorker() {
  if (!worker) return;
  worker.kill("SIGKILL");
  await until(
    () => worker!.exitCode !== null || worker!.signalCode !== null,
    "worker process gone",
    20000,
  );
}

/**
 * 12 格的执行骨架。`fault` 负责制造故障并保证故障期间结果只可能落在磁盘上，
 * `settle` 负责恢复组件并给出这一格应当观测到的终态。
 */
type Cell = {
  id: string;
  fault: "host-disconnect" | "host-restart" | "worker-restart" | "machine-restart";
  status: "short-running" | "long-running" | "completed-unretrieved";
};
async function runCell(cell: Cell) {
  const marker = `mtx-${randomUUID()}`;
  const requestId = newId(ID_PREFIXES.request);
  const command =
    cell.status === "completed-unretrieved"
      ? `echo start; : ${marker}; sleep 5; echo done >> "${join(effectsDirectory, `${marker}.log`)}"`
      : `echo start; : ${marker}; sleep ${cell.status === "short-running" ? 14 : 120}; echo done >> "${join(effectsDirectory, `${marker}.log`)}"`;
  const first = await withActiveRun(() => submit(requestId, command));
  await until(
    async () => (await pollView(first.executionId))?.state === "running",
    `${cell.id} running`,
  );
  const startedAt = Date.now();

  const injected = Date.now();
  let expectedLabel = "";
  if (cell.fault === "host-disconnect") {
    // 连接断开、两个进程都活着：冻结服务到超过 Worker 的 exchange 超时（8s）。
    service!.kill("SIGSTOP");
    if (cell.status === "completed-unretrieved") {
      await until(() => existsSync(resultPath(first.executionId)), `${cell.id} runner result`);
      service!.kill("SIGCONT");
    } else {
      await sleep(9500);
      service!.kill("SIGCONT");
    }
  } else if (cell.fault === "host-restart") {
    await stop(service);
    if (cell.status === "completed-unretrieved")
      await until(() => existsSync(resultPath(first.executionId)), `${cell.id} runner result`);
    else await sleep(1500);
    service = launch(
      ["--import", "tsx", "tests/fixtures/execution-live-service.ts"],
      "service-restart.log",
      true,
    );
    await healthy();
    // 宿主重启后进程内的 grant 注册表是空的：真实产品沿用同一 chat 与同一 agent instance，
    // 只新建一条 run 与 grant（与 execution-live-e2e 的 S9 同一条路径）。
    const restartRunId = `run_${randomUUID()}`;
    sqlite
      .prepare(
        "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
      )
      .run(
        restartRunId,
        instanceId,
        chatId,
        projectId,
        newId(ID_PREFIXES.request),
        Math.floor(Date.now() / 1000),
        randomBytes(16).toString("hex"),
      );
    runId = restartRunId;
    await useIssuedGrant();
  } else if (cell.fault === "worker-restart") {
    await stopWorker();
    if (cell.status === "completed-unretrieved")
      await until(() => existsSync(resultPath(first.executionId)), `${cell.id} runner result`);
    await startWorker();
  } else {
    await stopWorker();
    if (cell.status === "completed-unretrieved") {
      // 结果已落盘后再让机器全灭：这是「已完成」能跨重启查回的唯一原因。
      await until(() => existsSync(resultPath(first.executionId)), `${cell.id} runner result`);
      await sleep(200);
    }
    killExecutionGroup(first.executionId);
    await startWorker();
  }
  const faulted = Date.now();
  const settleUnknown = async () => {
    await until(
      async () => (await pollView(first.executionId))?.state === "unknown",
      `${cell.id} unknown`,
    );
    const settled = await view(first.executionId);
    assert.equal(
      settled.recoveryReason,
      "child-exited-without-result",
      `${cell.id} unknown must carry its reason`,
    );
    return settled;
  };
  const settleExited = async (label: string) => {
    await until(
      async () => (await pollView(first.executionId))?.state === "succeeded",
      `${cell.id} succeeded`,
      45000,
    );
    const settled = await view(first.executionId);
    const payload = settled.result as { exitCode?: number } | null;
    assert.equal(payload?.exitCode, 0, `${cell.id} exit code 0`);
    expectedLabel = label;
    return settled;
  };

  let settled: ExecutionView;
  if (cell.status === "completed-unretrieved") {
    // 结果在故障期间已落盘：连机器全灭都能查回 exited:0。
    settled = await settleExited("exited:0");
  } else if (cell.status === "long-running") {
    if (cell.fault === "machine-restart") {
      // 进程随机器一起消失，没有结果：这一格本来就该 unknown。
      settled = await settleUnknown();
      expectedLabel = "unknown:child-exited-without-result";
    } else {
      settled = await view(first.executionId);
      assert.equal(settled.state, "running", `${cell.id} must still read as running`);
      assert.equal(settled.terminalAt, null, `${cell.id} running must not be terminal`);
      expectedLabel = "running";
      if (cell.fault === "worker-restart") {
        // 新的 Worker 认领孤儿后一直报 running；孤儿被杀且没有结果才落 unknown。
        killExecutionGroup(first.executionId);
        settled = await settleUnknown();
        expectedLabel = "running -> unknown:child-exited-without-result";
      }
    }
  } else if (cell.fault === "machine-restart") {
    // 机器全灭时命令还在跑：没有结果可归约，只能报带原因的 unknown。
    settled = await settleUnknown();
    expectedLabel = "unknown:child-exited-without-result";
  } else {
    settled = await settleExited("running -> exited:0");
  }

  // 每格统一的反证：一条请求一条执行、副作用一次、重提交不改状态也不重跑。
  const rows = (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM remote_execution WHERE request_id=?")
      .get(requestId) as {
      n: number;
    }
  ).n;
  assert.equal(rows, 1, `${cell.id} one execution per requestId`);
  const effectsBefore = effects(marker);
  // 机器全灭时命令死在副作用之前：这一格证明「没有第二次执行」，不是「副作用发生过」。
  // 已完成未取结果的格相反：副作用在死前就写完了，必须仍是 1 行。
  const expectedEffects =
    cell.status === "long-running"
      ? null
      : cell.status === "completed-unretrieved" || cell.fault !== "machine-restart"
        ? 1
        : 0;
  if (expectedEffects !== null)
    assert.equal(effectsBefore, expectedEffects, `${cell.id} effects ${expectedEffects}`);
  const replay = await withActiveRun(() => submit(requestId, command));
  assert.equal(replay.executionId, first.executionId, `${cell.id} replay reuses the execution`);
  assert.equal(replay.state, settled.state, `${cell.id} replay keeps the same state`);
  assert.equal(effects(marker), effectsBefore, `${cell.id} replay must not re-run`);

  killExecutionGroup(first.executionId);
  cells.push({
    cell: cell.id,
    expected: expectedLabel,
    actual: `${settled.state}${settled.recoveryReason ? `:${settled.recoveryReason}` : ""}`,
  });
  console.log(
    `cell ${cell.id.padEnd(42)} expected=${expectedLabel.padEnd(46)} actual=${settled.state}${settled.recoveryReason ? `:${settled.recoveryReason}` : ""} fault=${faulted - injected}ms total=${faulted - startedAt}ms`,
  );
}

try {
  service = launch(
    ["--import", "tsx", "tests/fixtures/execution-live-service.ts"],
    "service.log",
    true,
  );
  await healthy();
  const signup = await fetch(base + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({
      email: `matrix-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: "matrix-owner",
    }),
  });
  assert.equal(signup.status, 200);
  userId = ((await signup.json()) as { user: { id: string } }).user.id;
  ({ sqlite } = await import("../../src/db"));
  const { createMachine, saveProjectMachineBinding } = await import("../../src/domain/machine");
  const { seedRemoteActor } = await import("./remote-actors");
  const bootId = (
    sqlite.prepare("SELECT id FROM runtime_boot ORDER BY started_at DESC LIMIT 1").get() as {
      id: string;
    }
  ).id;
  projectId = newId(ID_PREFIXES.project);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Recovery matrix',?)")
    .run(projectId, userId);
  const actor = seedRemoteActor(sqlite, userId, projectId, bootId, false);
  runId = actor.runId;
  instanceId = actor.instanceId;
  chatId = actor.chatId;
  const now = () => ({ ...actor, now: new Date(), requestId: newId(ID_PREFIXES.request) });
  const machine = createMachine({ name: "Recovery matrix macOS" }, now());
  machineId = machine.detail.machine.id;
  saveProjectMachineBinding(
    { projectId, machineId, description: "matrix", expectedRevision: null },
    now(),
  );
  sqlite.prepare("UPDATE agent_run SET status='queued',started_at=NULL WHERE id=?").run(runId);
  await useIssuedGrant();
  sqlite
    .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000), runId);
  await accept("sprout_lease_acquire", {
    machineId,
    requestId: newId(ID_PREFIXES.request),
    expectedGeneration: 0,
  });
  generation = 1;
  const ticket = join(directory, "private-ticket");
  writeFileSync(ticket, machine.ticket, { mode: 0o600 });
  const init = launch(
    [
      "dist/worker/main.js",
      "init",
      "--server",
      base,
      "--machine",
      machineId,
      "--state-dir",
      state,
      "--ticket-file",
      ticket,
    ],
    "init.log",
  );
  await until(() => init.exitCode !== null, "Worker enrollment");
  assert.equal(init.exitCode, 0);
  await startWorker();

  // 第二轮验收可直接挑单格重跑：SPROUT_MATRIX_CELLS=host-restart__short-running
  const only = (process.env.SPROUT_MATRIX_CELLS ?? "").split(",").filter(Boolean);
  for (const fault of [
    "host-disconnect",
    "host-restart",
    "worker-restart",
    "machine-restart",
  ] as const)
    for (const status of ["short-running", "long-running", "completed-unretrieved"] as const) {
      const id = `${fault}__${status}`;
      if (only.length > 0 && !only.includes(id)) continue;
      await runCell({ id, fault, status });
    }

  console.log(`aj-recovery-matrix: PASS (${cells.length} cells)`);
  for (const cell of cells)
    console.log(`  ${cell.cell}: expected=${cell.expected} actual=${cell.actual}`);
} finally {
  for (const child of children.reverse()) {
    try {
      process.kill(child.pid!, "SIGCONT");
    } catch {
      // 不在冻结状态即目标状态。
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出即目标状态。
    }
  }
  await sleep(200);
}
