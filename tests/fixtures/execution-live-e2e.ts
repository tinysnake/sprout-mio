// I-P4c 真实端到端：真实 macOS Worker、真实服务、真实 SQLite、真实 agent 工具面。
// 工具调用走 production 的 registerRemoteTools + createRemoteClient（与 Pi host 同一接线），
// 断线/重启/取消都作用在真实子进程上。命令正文、日志正文、cookie、token 都不进证据文件。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionView, RemoteToolGrant } from "../../src/contracts/remote";
import type { AppResult } from "../../src/contracts/result";
import { createRemoteClient } from "../../src/extension/remote-client";
import { registerRemoteTools } from "../../src/extension/remote-tools";
import type { SproutExtensionAPI, SproutToolResult } from "../../src/extension/types";

import { selectAhGroups, validateAhCoverage } from "../../scripts/verify/lib/ah-manifest.mjs";
import { cleanupAhFixture } from "../../scripts/verify/lib/ah-cleanup.mjs";

const selected = process.argv.slice(2);
const group = selected.length ? selectAhGroups(selected)[0] : null;
const includes = (name: string) => group === null || group === name;
assert.equal(process.platform, "darwin", "real macOS Worker required");
assert(
  existsSync(".output/server/index.mjs") && existsSync("dist/worker/main.js"),
  "run the matching scripts/verify shell entry to prepare current app and Worker artifacts",
);

mkdirSync(".verify", { recursive: true });
const directory =
  process.env.AH_FIXTURE_DIRECTORY ?? mkdtempSync(resolve(".verify/ah-execution-live-"));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const evidencePath = join(directory, "evidence.json");
const children: ReturnType<typeof spawn>[] = [];
const checks: { id: string; name: string }[] = [];
const readiness: string[] = [];
let completed = false;
const facts: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const pass = (id: string, name: string) => {
  if (["service", "tools", "worker"].includes(id) && group !== null && group !== "execution")
    readiness.push(id);
  else checks.push({ id, name });
  console.log(`PASS ${name}`);
};
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`Timeout: ${message}`);
}
async function freePort(except: number[] = []) {
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((res) => server.close(() => res()));
  assert.notEqual(port, 3000);
  assert(!except.includes(port));
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
  // 私有验收库缩小保留阈值，让真实写入在可接受时间内触发裁剪。
  SPROUT_EXECUTION_LOG_RETAIN_BYTES: "65536",
};
/** 服务进程与 fixture 进程各持一份 SQLite 连接；两边都只读写同一私有库。 */
Object.assign(process.env, {
  DATABASE_URL: env.DATABASE_URL,
  APP_ORIGIN: base,
  BETTER_AUTH_SECRET: secret,
  NODE_ENV: "production",
  SPROUT_PI_ENABLED: "false",
});
function launch(args: string[], name: string, ipc = false) {
  assert(!cleanupPromise, "no new components during cleanup");
  const log = join(directory, name);
  const fd = openSync(log, "w", 0o600);
  const child = spawn(process.execPath, args, {
    env,
    stdio: ipc ? ["ignore", fd, fd, "ipc"] : ["ignore", fd, fd],
  });
  closeSync(fd);
  children.push(child);
  writeFileSync(
    join(directory, "processes.json"),
    JSON.stringify(children.map((entry) => entry.pid)),
    { mode: 0o600 },
  );
  child.once("exit", (code, signal) => {
    // 诊断：真实链路上一旦进程意外退出，日志里必须能看见是谁、因为什么。
    if (name !== "service.log" && name !== "service-restart.log")
      console.log(`[fixture] ${name} exited code=${code} signal=${signal}`);
  });
  return child;
}
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "owned process stop",
    20000,
  );
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** 只数真实子进程，不猜。pgrep 无匹配时退出码为 1。 */
function processCount(marker: string) {
  const result = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  if (result.status !== 0) return 0;
  return result.stdout.split("\n").filter((line) => line.trim()).length;
}
/** 进程真实启动时间，用来证明它是本次执行拉起的。 */
function processStartedAt(pid: number) {
  // 系统 locale 会影响 lstart 的月份/星期写法；固定 C locale 才能解析。
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  assert.equal(result.status, 0, "ps lstart failed");
  const started = new Date(result.stdout.trim());
  assert(Number.isFinite(started.getTime()), "ps lstart must parse");
  return started;
}

const childrenPids = new Set<number>();
const completionFiles = new Set<string>();
let service: ReturnType<typeof spawn> | undefined;
async function control(
  action: "issue" | "revoke" | "cleanup" | "human_cancel",
  payload: { runId?: string; raw?: unknown; cookie?: string; requestId?: string } = {},
) {
  assert(service?.connected, "service IPC required");
  const id = randomUUID();
  return new Promise<{ ok: boolean; grant?: RemoteToolGrant; result?: AppResult<unknown> }>(
    (res, rej) => {
      const timer = setTimeout(() => {
        service!.off("message", receive);
        rej(new Error("private control timeout"));
      }, 20000);
      const receive = (message: {
        id: string;
        ok: boolean;
        grant?: RemoteToolGrant;
        result?: AppResult<unknown>;
      }) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        service!.off("message", receive);
        res(message);
      };
      service!.on("message", receive);
      service!.send({ id, action, ...payload });
    },
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

type RegisteredTool = Parameters<Pick<SproutExtensionAPI, "registerTool">["registerTool"]>[0];
type LogFrame = { sequence: number; text: string | null; byteStart: number; byteEnd: number };
type LogDetails = {
  outcome: string;
  incomplete: boolean;
  logState: string;
  frames: LogFrame[];
  nextCursor: { executionId: string; nextSequence: number };
  producedThroughSequence: number | null;
  acknowledgedThroughSequence: number | null;
  availableFromSequence: number | null;
  workerOnline: boolean;
  gapRanges: { fromSequence: number; toSequence: number }[];
  message: string;
};
type CancelView = {
  cancelId: string;
  executionId: string;
  state: string;
  signalOutcome: string;
  failureReason: string | null;
  deliveredAt: string | null;
  exitedAt: string | null;
};
type CancelDetails = {
  outcome: string;
  stopped: boolean;
  message: string;
  cancellation: CancelView;
};
type ExecutionDetails = { outcome: string; data: ExecutionView };

let tools = new Map<string, RegisteredTool>();
function useGrant(grant: RemoteToolGrant) {
  tools = new Map();
  registerRemoteTools(
    { registerTool: (tool) => void tools.set(tool.name, tool) } as Pick<
      SproutExtensionAPI,
      "registerTool"
    >,
    createRemoteClient(grant),
  );
}
async function call(name: string, parameters: Record<string, unknown>): Promise<SproutToolResult> {
  const tool = tools.get(name);
  assert(tool, `${name} must be registered`);
  return tool.execute(`${name}-${randomUUID()}`, parameters);
}
async function accept<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
  const result = await call(name, parameters);
  assert.notEqual(
    result.isError,
    true,
    `${name} rejected: ${JSON.stringify(result.details.error ?? result.details.reason)}`,
  );
  return result.details as T;
}

let sqlite!: typeof import("../../src/db").sqlite;
let machineId = "";
let projectId = "";
let userId = "";
let cookie = "";
let otherCookie = "";

let marker = "";
/**
 * execution_get 的可见状态本身就是事实：`unknown` 会让工具报 isError，但 data 仍是执行视图。
 * 读取路径必须容忍这一点，不能把 unknown 当成「工具被拒」。
 */
async function getView(id: string): Promise<ExecutionView> {
  const result = await call("sprout_remote_execution_get", { machineId, executionId: id });
  const details = result.details as { data?: ExecutionView; outcome?: string };
  assert(details.data, `execution_get must return a view, got ${JSON.stringify(details)}`);
  assert.equal(details.data.executionId, id);
  return details.data;
}
const readLog = async (
  executionId: string,
  cursor: { executionId: string; nextSequence: number } | null,
  limitBytes = 65536,
) =>
  accept<LogDetails>("sprout_remote_execution_log", {
    machineId,
    executionId,
    cursor,
    limitBytes,
  });

/** Worker 重连后机器能力可能在下一轮 exchange 才可见：machine_unavailable 只用同一个 requestId 重试。 */
async function submitShell(parameters: {
  requestId: string;
  command: string;
  waitMs?: number;
}): Promise<ExecutionDetails> {
  const deadline = Date.now() + 45000;
  for (;;) {
    try {
      return await accept<ExecutionDetails>("sprout_remote_shell", {
        machineId,
        requestId: parameters.requestId,
        authorizationGeneration: generation,
        command: parameters.command,
        cwd: directory,
        waitMs: parameters.waitMs ?? 1000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("machine_unavailable") || Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}

/** 服务重启会把代理 run 标成 interrupted；工具面每次请求前把它重新激活（同一真实 run）。 */
async function withActiveRun<T>(runId: string, action: () => Promise<T>): Promise<T> {
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

async function signup(label: string) {
  const response = await fetch(base + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({
      email: `${label}-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"),
      name: label,
    }),
  });
  assert.equal(response.status, 200, `${label} signup`);
  const account = (await response.json()) as { user: { id: string } };
  const cookies = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");
  return { userId: account.user.id, cookie: cookies };
}

const markerOf = () => `marker-${randomUUID()}`;
// 宿主下发的 shell 命令没有 max_runtime_ms 入参：真实产品路径默认无运行上限，
// 这里直接连真实服务，不再由 fixture 代理补字段。
const workerBase = base;

let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= cleanupAhFixture({ children, state, completionFiles, childrenPids }));
}
function writeEvidence() {
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        group,
        status: interrupted ? "interrupted" : completed ? "passed" : "failed",
        ok: checks.length,
        checks,
        readiness,
        facts,
        artifacts: { directory, logs: children.length },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
let interrupted = false;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    void cleanup().finally(() => {
      writeEvidence();
      process.exit(code);
    });
  });
}

let generation = 1;
try {
  service = launch(
    ["--import", "tsx", "tests/fixtures/execution-live-service.ts"],
    "service.log",
    true,
  );
  await healthy();
  const owner = await signup("live-owner");
  const other = await signup("live-other");
  userId = owner.userId;
  cookie = owner.cookie;

  otherCookie = other.cookie;
  pass("service", "real production service, isolated SQLite and two new accounts");

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
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Execution live',?)")
    .run(projectId, userId);
  const actor = seedRemoteActor(sqlite, userId, projectId, bootId, false);
  const now = () => ({ ...actor, now: new Date(), requestId: newId(ID_PREFIXES.request) });
  const machine = createMachine({ name: "Execution live macOS" }, now());
  machineId = machine.detail.machine.id;
  const key = { projectId, machineId };
  saveProjectMachineBinding({ ...key, description: "live", expectedRevision: null }, now());
  sqlite
    .prepare("UPDATE agent_run SET status='queued',started_at=NULL WHERE id=?")
    .run(actor.runId);
  const issued = await control("issue", { runId: actor.runId });
  assert(issued.ok && issued.grant, "real grant issued by the production service");
  useGrant(issued.grant);
  pass("tools", "real remote tool surface registered against the production service");

  sqlite
    .prepare("UPDATE agent_run SET status='running',started_at=? WHERE id=?")
    .run(Math.floor(Date.now() / 1000), actor.runId);
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
      workerBase,
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
  const connectionSeq = () =>
    (
      sqlite
        .prepare("SELECT seq FROM machine_connection WHERE machine_id=? ORDER BY generation DESC")
        .get(machineId) as { seq: number } | undefined
    )?.seq ?? 0;
  let worker = launch(["dist/worker/main.js", "run", "--state-dir", state], "worker.log");
  await until(() => connectionSeq() >= 1, "Worker heartbeat");
  pass("worker", "real macOS Worker enrolled and streaming into the production service");

  if (includes("execution")) {
    // —— 场景 1/2/3（同一长命令）：执行 ID ↔ 真实进程、同 requestId 去重、日志游标。 ——
    marker = markerOf();
    const requestId = newId(ID_PREFIXES.request);
    const command = `echo start; echo pid=$$; : ${marker}; i=0; while [ $i -lt 20 ]; do echo line=$i; i=$((i+1)); sleep 1; done; echo done`;
    const submittedAt = Date.now();
    const primary = (await submitShell({ requestId, command })).data;
    assert.equal(primary.requestId, requestId);
    await until(
      async () => {
        const view = await readLog(primary.executionId, null, 4096);
        return view.frames.some((frame) => (frame.text ?? "").includes("pid="));
      },
      "pid line in the real log",
      30000,
    );
    const firstRead = await readLog(primary.executionId, null, 4096);
    const pidFrame = firstRead.frames.find((frame) => (frame.text ?? "").includes("pid="));
    assert(pidFrame?.text, "pid frame text required");
    const pid = Number(/pid=(\d+)/.exec(pidFrame.text)![1]);
    childrenPids.add(pid);
    assert(alive(pid), `real child process ${pid} must be alive`);
    const startedAt = processStartedAt(pid);
    assert(
      startedAt.getTime() >= submittedAt - 1000,
      `process start ${startedAt.toISOString()} must follow submit`,
    );
    facts.scenario1 = {
      executionId: primary.executionId,
      requestId,
      pid,
      alive: true,
      processStartedAt: startedAt.toISOString(),
      submittedAt: new Date(submittedAt).toISOString(),
    };
    pass("S1", "S1 executionId maps to a real child process started by this execution");

    const beforeDedupe = await getView(primary.executionId);
    const replayed = await submitShell({ requestId, command });
    assert.equal(
      replayed.data.executionId,
      primary.executionId,
      "same requestId reuses the execution",
    );
    assert.equal(processCount(marker), 1, "only one real child process for the same requestId");
    const afterDedupe = await getView(primary.executionId);
    assert.equal(
      afterDedupe.dispatchSeq,
      beforeDedupe.dispatchSeq,
      "dedupe must not dispatch again",
    );
    facts.scenario2 = {
      executionId: primary.executionId,
      requestId,
      dispatchSeqBefore: beforeDedupe.dispatchSeq,
      dispatchSeqAfter: afterDedupe.dispatchSeq,
      processCount: processCount(marker),
    };
    pass("S2", "S2 repeated requestId returns the same execution without a second dispatch");

    // 游标：小预算分页读到 line=5，序号单调、不重复、nextCursor 推进。
    const pages: { cursor: number; sequences: number[]; nextCursor: number }[] = [];
    let cursor: { executionId: string; nextSequence: number } | null = null;
    let reachedFive = false;
    const seenSequences = new Set<number>();
    const pageDeadline = Date.now() + 60000;
    while (!reachedFive && Date.now() < pageDeadline) {
      const view = await readLog(primary.executionId, cursor, 128);
      const sequences = view.frames.map((frame) => frame.sequence);
      for (const sequence of sequences) {
        assert(!seenSequences.has(sequence), "cursor paging must not repeat a sequence");
        seenSequences.add(sequence);
      }
      if (cursor)
        assert(view.nextCursor.nextSequence >= cursor.nextSequence, "nextCursor advances");
      pages.push({
        cursor: cursor?.nextSequence ?? 0,
        sequences,
        nextCursor: view.nextCursor.nextSequence,
      });
      reachedFive = view.frames.some((frame) => (frame.text ?? "").includes("line=5"));
      cursor = view.nextCursor;
      // 空范围只说明当前没有新帧，不等于没有输出：等下一批上行再续读。
      await sleep(view.frames.length ? 50 : 300);
    }
    assert(reachedFive, "cursor paging must reach line=5 of the real log");
    const idempotentCursor = {
      executionId: primary.executionId,
      nextSequence: pages[1]!.nextCursor,
    };
    const idempotent = await readLog(primary.executionId, idempotentCursor, 65536);
    const again = await readLog(primary.executionId, idempotentCursor, 65536);
    assert.deepEqual(
      again.frames.map((frame) => frame.sequence),
      idempotent.frames.map((frame) => frame.sequence),
      "same cursor must return the same frames",
    );
    // 跨执行游标：按实现记录真实行为，不改写。
    const shortExecution = (
      await submitShell({
        requestId: newId(ID_PREFIXES.request),
        command: "echo b1; echo b2; echo b3",
        waitMs: 4000,
      })
    ).data;
    await until(
      async () => (await getView(shortExecution.executionId)).terminalAt !== null,
      "short execution terminal",
      30000,
    );
    const cross = await call("sprout_remote_execution_log", {
      machineId,
      executionId: shortExecution.executionId,
      cursor: { executionId: primary.executionId, nextSequence: 40 },
      limitBytes: 4096,
    });
    assert.equal(cross.isError, true, "cross-execution cursor must be rejected");
    const crossCode = (cross.details as { error?: { code?: string } }).error?.code;
    assert.equal(crossCode, "execution_log_cursor_stale");
    facts.scenario3 = {
      pages: pages.length,
      sequencesMonotonic: true,
      reachedLine5: true,
      idempotentFrames: idempotent.frames.length,
      crossCursor: {
        executionFrom: primary.executionId,
        executionTo: shortExecution.executionId,
        cursor: 40,
        rejected: true,
        code: crossCode,
      },
    };
    pass(
      "S3",
      "S3 cursor paging is monotonic, idempotent, and a cross-execution cursor is rejected",
    );

    // —— 场景 4/10：真实写入触发保留裁剪，旧游标被拒，新起点可续读，结果字段保留不变。 ——
    const bigRequest = newId(ID_PREFIXES.request);
    const big = (
      await submitShell({
        requestId: bigRequest,
        command:
          "i=0; while [ $i -lt 3000 ]; do printf 'x%07d-0123456789abcdefghijklmnopqrstuvwxyz\\n' \"$i\"; i=$((i+1)); done",
        waitMs: 8000,
      })
    ).data;
    await until(
      async () => (await getView(big.executionId)).terminalAt !== null,
      "big output terminal",
      60000,
    );
    // 终态 ACK 不等于日志已交代：Worker 的产出位点可能高于已送达帧，等补送与封口事实都到位。
    await until(
      async () => {
        const view = await getView(big.executionId);
        return (
          view.producedThroughSequence !== null &&
          view.acknowledgedThroughSequence === view.producedThroughSequence
        );
      },
      "big output log backfill",
      120000,
    );
    const bigFinal = await getView(big.executionId);
    assert.equal(bigFinal.logState, "truncated", "a 64 KiB threshold must trim the real log");
    assert(bigFinal.availableFromSequence !== null && bigFinal.availableFromSequence > 1);
    // 不带游标时从可读起点开始读：裁剪过的执行也能读到，不必先撞一次 gap。
    const firstPage = await call("sprout_remote_execution_log", {
      machineId,
      executionId: big.executionId,
      cursor: null,
      limitBytes: 4096,
    });
    assert.equal(
      firstPage.isError,
      false,
      "reading without a cursor must start at the readable start",
    );
    const firstPageDetails = firstPage.details as {
      availableFromSequence?: number | null;
      logState?: string;
      frames?: { sequence: number }[];
    };
    assert.equal(firstPageDetails.availableFromSequence, bigFinal.availableFromSequence);
    assert.equal(firstPageDetails.logState, "truncated");
    assert.ok(
      (firstPageDetails.frames ?? []).every(
        (frame) => frame.sequence >= bigFinal.availableFromSequence!,
      ),
      "the trimmed prefix must not be served as if it were readable",
    );
    // 显式早于可读起点的游标仍必须报 gap，不静默从新起点称完整。
    const staleRead = await call("sprout_remote_execution_log", {
      machineId,
      executionId: big.executionId,
      cursor: { executionId: big.executionId, nextSequence: 0 },
      limitBytes: 4096,
    });
    assert.equal(staleRead.isError, true, "a cursor before the available start must be rejected");
    assert.equal(
      (staleRead.details as { error?: { code?: string } }).error?.code,
      "execution_log_gap",
    );
    // 从可读起点逐页读到产出位点：序号单调、不重复、能读到最后。
    let bigCursor: { executionId: string; nextSequence: number } | null = {
      executionId: big.executionId,
      nextSequence: bigFinal.availableFromSequence! - 1,
    };
    const allSequences: number[] = [];
    let firstPageRemaining: number | null = null;
    for (let page = 0; page < 80; page++) {
      const view = await readLog(big.executionId, bigCursor, 16384);
      assert.equal(view.logState, "truncated");
      if (page === 0)
        firstPageRemaining = (view.producedThroughSequence ?? 0) - view.nextCursor.nextSequence;
      for (const frame of view.frames) allSequences.push(frame.sequence);
      if (view.nextCursor.nextSequence === bigCursor?.nextSequence) break;
      bigCursor = view.nextCursor;
      if (
        view.producedThroughSequence !== null &&
        view.nextCursor.nextSequence >= view.producedThroughSequence
      )
        break;
    }
    const unique = [...new Set(allSequences)];
    assert.equal(unique.length, allSequences.length, "paged read must not duplicate frames");
    assert.deepEqual(
      [...unique].sort((a, b) => a - b),
      unique,
      "paged read stays ordered",
    );
    assert.equal(unique[0], bigFinal.availableFromSequence, "only retained frames are readable");
    assert.equal(
      unique[unique.length - 1],
      bigFinal.producedThroughSequence,
      "the retained suffix reaches the last produced frame",
    );
    assert(
      firstPageRemaining !== null && firstPageRemaining > 0,
      "one page cannot hold the output",
    );
    assert(
      (bigFinal.result as { truncated?: boolean } | null)?.truncated === true,
      "the shell result keeps its own stdout cap and truncated flag",
    );
    facts.scenario4 = {
      executionId: big.executionId,
      requestId: bigRequest,
      producedThroughSequence: bigFinal.producedThroughSequence,
      framesRead: unique.length,
      firstRetainedSequence: bigFinal.availableFromSequence,
      firstPageFramesRemaining: firstPageRemaining,
      logState: bigFinal.logState,
      resultTruncated: (bigFinal.result as { truncated?: boolean } | null)?.truncated,
    };
    facts.scenario10 = {
      fixedRetentionRule: "1 MiB / 512 帧先到者触发（私有库 env 缩小到 64 KiB）",
      staleCursorCode: "execution_log_gap",
      silentLoss: false,
    };
    pass(
      "S4/S10",
      "S4/S10 real writes trigger retention, stale cursors are rejected, the retained suffix reads",
    );
  }
  if (includes("execution")) {
    // —— 场景 11：跨过 30 秒下发窗口的真实长命令仍在运行、日志继续、可取消。 ——
    const longMarker = markerOf();
    const longSubmittedAt = Date.now();
    const longRun = (
      await submitShell({
        requestId: newId(ID_PREFIXES.request),
        command: `echo pid=$$; : ${longMarker}; i=0; while [ $i -lt 120 ]; do echo tick=$i; i=$((i+1)); sleep 1; done`,
        waitMs: 1000,
      })
    ).data;
    await until(
      async () => (await getView(longRun.executionId)).state === "running",
      "long command running",
      30000,
    );
    const longStartLog = await readLog(
      longRun.executionId,
      { executionId: longRun.executionId, nextSequence: 0 },
      65536,
    );
    const longPid = Number(
      /pid=(\d+)/.exec(longStartLog.frames.map((frame) => frame.text ?? "").join(""))![1],
    );
    childrenPids.add(longPid);
    const longCursor = longStartLog.nextCursor;
    await until(
      async () => Date.now() >= longSubmittedAt + 40000,
      "cross the dispatch window",
      90000,
    );
    let afterWindow = await getView(longRun.executionId);
    assert.equal(afterWindow.state, "running", "a long command must survive its dispatch window");
    assert.equal(afterWindow.terminalAt, null, "no terminal before the real exit");
    assert.equal(afterWindow.runtimeDeadlineAt, null, "the product path has no runtime limit");
    assert.equal(afterWindow.maxRuntimeMs, null);
    assert(
      Date.now() > Date.parse(afterWindow.dispatchDeadlineAt),
      "the observation must be after the 30s dispatch window",
    );
    assert.equal(processCount(longMarker), 1, "exactly one long child process");
    // 日志按 5 秒一轮上行：等它追上 30 秒后的 tick，而不是拿某一瞬间的读取碰运气。
    let longLaterLog = await readLog(longRun.executionId, longCursor, 65536);
    await until(
      async () => {
        longLaterLog = await readLog(longRun.executionId, longCursor, 65536);
        return /tick=(3[1-9]|[4-9][0-9])/.test(
          longLaterLog.frames.map((frame) => frame.text ?? "").join(""),
        );
      },
      "logs cover ticks after 30 seconds",
      60000,
    );
    afterWindow = await getView(longRun.executionId);
    assert.equal(afterWindow.state, "running");
    const longCancel = await accept<CancelDetails>("sprout_remote_execution_cancel", {
      machineId,
      executionId: longRun.executionId,
      requestId: newId(ID_PREFIXES.request),
      authorizationGeneration: generation,
      policy: "term_then_kill",
      termWaitMs: 2000,
    });
    assert.equal(
      longCancel.stopped,
      false,
      "delivery of the cancel intent is not a stopped process",
    );
    await until(
      async () => (await getView(longRun.executionId)).cancellation?.state === "exited_observed",
      "long command cancel observed",
      60000,
    );
    const longFinal = await getView(longRun.executionId);
    // 用户主动取消不是掤权：执行仍然是终态 failed，但原因必须说「已取消」。
    assert.equal(longFinal.state, "failed", "a cancelled long command stays a failed terminal");
    assert.equal(longFinal.failureReason, "cancelled");
    assert.equal(
      longFinal.recoveryReason,
      null,
      "there is a durable result: nothing is unrecorded",
    );
    assert.equal(processCount(longMarker), 0, "the cancelled process must be gone");
    facts.scenario11 = {
      executionId: longRun.executionId,
      pid: longPid,
      runtimeDeadlineAt: afterWindow.runtimeDeadlineAt,
      dispatchDeadlineAt: afterWindow.dispatchDeadlineAt,
      stateAfterDispatchWindow: afterWindow.state,
      logFramesAfterWindow: longLaterLog.frames.length,
      cancelState: longFinal.cancellation?.state,
      finalState: longFinal.state,
      failureReason: longFinal.failureReason,
    };
    pass(
      "S11",
      "S11 a real long command crosses the dispatch window, keeps logging, and is cancelled",
    );
  }
  let disconnect!: ExecutionView;
  if (includes("recovery")) {
    // —— 场景 5/8：命令运行中 Worker 掉线并重启。 ——
    const disconnectMarker = markerOf();
    disconnect = (
      await submitShell({
        requestId: newId(ID_PREFIXES.request),
        // 命令启动后不再写 stdout：Worker 进程退出会关闭管道，持续写会因 SIGPIPE 死亡，
        // 那会掩盖「断联本身不发信号」这一被验证的事实。
        // `: marker` 放在最后，shell 不会把 argv exec 成 sleep，marker 才始终在进程命令行里。
        command: `echo pid=$$; sleep 20; : ${disconnectMarker}`,
      })
    ).data;
    await until(
      async () => (await getView(disconnect.executionId)).state === "running",
      "disconnect target running",
      30000,
    );
    const disconnectPidText = (await readLog(disconnect.executionId, null, 4096)).frames
      .map((frame) => frame.text ?? "")
      .join("");
    const disconnectPid = Number(/pid=(\d+)/.exec(disconnectPidText)![1]);
    childrenPids.add(disconnectPid);
    await stop(worker);
    await until(() => worker.exitCode !== null, "worker stopped for restart");
    assert(alive(disconnectPid), "disconnect must not kill the running child process");
    const cursorBeforeDrop = await readLog(disconnect.executionId, null, 65536);
    // 断联只影响新鲜度，不产生终态：每次读取都会跑 expireExecutions，状态必须一直是 running。
    // 命令可能还在跑，也可能已经落盘退出，这两种事实都只能由 Worker 归约后交回。
    const whileWorkerDown: string[] = [];
    for (let i = 0; i < 12; i++) {
      const view = await getView(disconnect.executionId);
      whileWorkerDown.push(view.state);
      assert.equal(view.terminalAt, null, "a lost connection must not produce a terminal");
      await sleep(250);
    }
    assert.deepEqual(
      [...new Set(whileWorkerDown)],
      ["running"],
      "the execution must stay non-terminal while the Worker is gone",
    );
    assert.equal(processCount(disconnectMarker), 1, "no terminal state may re-run the command");
    const beforeRestartExecutions = (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM remote_execution WHERE request_id=?")
        .get(disconnect.requestId) as {
        n: number;
      }
    ).n;
    worker = launch(["dist/worker/main.js", "run", "--state-dir", state], "worker-restart.log");
    await until(() => connectionSeq() >= 2, "Worker reconnect");
    const afterReconnect = await readLog(
      disconnect.executionId,
      {
        executionId: disconnect.executionId,
        nextSequence: cursorBeforeDrop.nextCursor.nextSequence,
      },
      65536,
    );
    for (const frame of cursorBeforeDrop.frames)
      assert(
        !afterReconnect.frames.some((next) => next.sequence === frame.sequence),
        "reconnected reads must not repeat frames",
      );
    assert.equal(processCount(disconnectMarker), 1, "reconnect must not spawn a second process");
    const afterRestartExecutions = (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM remote_execution WHERE request_id=?")
        .get(disconnect.requestId) as {
        n: number;
      }
    ).n;
    assert.equal(
      afterRestartExecutions,
      beforeRestartExecutions,
      "no implicit re-run on reconnect",
    );
    facts.scenario5 = {
      executionId: disconnect.executionId,
      pid: disconnectPid,
      childAliveWhileWorkerDown: true,
      cursorBeforeDrop: cursorBeforeDrop.nextCursor.nextSequence,
      framesAfterReconnect: afterReconnect.frames.length,
      logStateAfterReconnect: afterReconnect.logState,
      executionsForRequest: afterRestartExecutions,
    };
    facts.scenario8 = {
      executionId: disconnect.executionId,
      stateWhileWorkerDown: "running",
      failureReasonWhileWorkerDown: null,
      processCountWhileDown: processCount(disconnectMarker),
      pidBeforeRestart: disconnectPid,
      pidAfterRestart: disconnectPid,
      implicitRerun: false,
    };
    pass(
      "S8",
      "S8 a Worker restart leaves the execution non-terminal until a real exit fact arrives",
    );
  }
  if (includes("cancellation")) {
    // —— 场景 6：分身经工具面取消另一条长命令。 ——
    const cancelledMarker = markerOf();
    const doomed = (
      await submitShell({
        requestId: newId(ID_PREFIXES.request),
        command: `echo pid=$$; : ${cancelledMarker}; trap '' TERM; i=0; while [ $i -lt 40 ]; do echo tick=$i; sleep 1; done`,
        waitMs: 1000,
      })
    ).data;
    await until(
      async () => (await getView(doomed.executionId)).state === "running",
      "cancelled command running",
      30000,
    );
    const cancelledPid = (await readLog(doomed.executionId, null, 4096)).frames
      .map((frame) => /pid=(\d+)/.exec(frame.text ?? "")?.[1])
      .find(Boolean);
    assert(cancelledPid, "cancelled command pid");
    childrenPids.add(Number(cancelledPid));
    const cancelRequest = newId(ID_PREFIXES.request);
    const cancelResult = await accept<CancelDetails>("sprout_remote_execution_cancel", {
      machineId,
      executionId: doomed.executionId,
      requestId: cancelRequest,
      authorizationGeneration: generation,
      policy: "term_then_kill",
      termWaitMs: 1000,
    });
    assert(!cancelResult.stopped, "a cancel intent is not a stop");
    const cancelStates: string[] = [cancelResult.cancellation.state];
    const deliveredView = await getView(doomed.executionId);
    assert.equal(deliveredView.state, "running", "delivered cancel must not rewrite execution");
    await until(
      async () => {
        const view = await getView(doomed.executionId);
        const state = view.cancellation?.state ?? "none";
        if (cancelStates.at(-1) !== state) cancelStates.push(state);
        return state === "delivered" || state === "failed" || state === "exited_observed";
      },
      "cancel delivered",
      40000,
    );
    const deliveredSnapshot = await getView(doomed.executionId);
    if (deliveredSnapshot.cancellation?.state === "delivered")
      assert.equal(deliveredSnapshot.state, "running", "delivered must not claim stopped");
    await until(
      async () => {
        const view = await getView(doomed.executionId);
        const state = view.cancellation?.state ?? "none";
        if (cancelStates.at(-1) !== state) cancelStates.push(state);
        return state === "exited_observed" || state === "failed" || state === "unknown";
      },
      "cancel settled",
      60000,
    );
    const cancelled = await getView(doomed.executionId);
    // 托管分离后 KILL 只打命令组，runner 活着把 result.json 落盘：退出是被观测到的。
    // 「取消成功但显示退出未被记录」是反向的不诚实，这里必须回到 exited_observed。
    assert.equal(
      cancelled.cancellation?.state,
      "exited_observed",
      "a KILL of the command group keeps the runner alive, so the exit is observed",
    );
    assert.notEqual(
      cancelled.cancellation?.exitedAt,
      null,
      "a durable result carries the exit time",
    );
    assert.equal(cancelled.cancellation?.failureReason, null);
    assert.equal(cancelled.state, "failed", "the execution is no longer running");
    assert.equal(cancelled.failureReason, "cancelled");
    assert.equal(
      cancelled.recoveryReason,
      null,
      "there is a durable result: nothing is unrecorded",
    );
    assert.equal(
      processCount(cancelledMarker),
      0,
      "the killed command group leaves nothing behind",
    );
    const cancelPayload = cancelled.result as {
      kind: string;
      failureReason?: string;
      partial?: { exited?: boolean; exitCode?: number | null };
    };
    assert.equal(cancelPayload.kind, "shell");
    assert.equal(cancelPayload.failureReason, "cancelled");
    // 取消后终态最后一关（不能绕过已撤销的授权）会收起正文本体，这是既有行为；
    // durable result 的存在由上面的 exitedAt 与 recoveryReason=null 证明。
    assert.notEqual(
      cancelled.cancellation.signalOutcome,
      "none",
      "the signal delivery is recorded",
    );
    facts.scenario6 = {
      executionId: doomed.executionId,
      pid: Number(cancelledPid),
      cancelStates,
      finalExecutionState: cancelled.state,
      resultFailureReason: cancelPayload.failureReason,
      signalOutcome: cancelled.cancellation.signalOutcome,
      actorKind: (
        sqlite
          .prepare("SELECT actor_kind FROM execution_cancellation WHERE execution_id=?")
          .get(doomed.executionId) as { actor_kind: string }
      ).actor_kind,
    };
    pass(
      "S6",
      "S6 agent cancel of a TERM-ignoring command is exited_observed: command group killed, runner survives",
    );

    // —— 场景 6b：合法的 10 秒 TERM 宽限。——
    // 忽略 TERM 的命令 + termWaitMs=10000：KILL 在 10 秒后才到，退出观测必须覆盖这段宽限，
    // 否则 Worker 提前交回 running、确认窗口又把它判成 delivery_unconfirmed。
    const graceMarker = markerOf();
    const graceTarget = (
      await submitShell({
        requestId: newId(ID_PREFIXES.request),
        command: `echo pid=$$; : ${graceMarker}; trap '' TERM; i=0; while [ $i -lt 30 ]; do echo tick=$i; sleep 1; done`,
        waitMs: 1000,
      })
    ).data;
    await until(
      async () => (await getView(graceTarget.executionId)).state === "running",
      "grace command running",
      30000,
    );
    const gracePid = (await readLog(graceTarget.executionId, null, 4096)).frames
      .map((frame) => /pid=(\d+)/.exec(frame.text ?? "")?.[1])
      .find(Boolean);
    assert(gracePid, "grace command pid");
    childrenPids.add(Number(gracePid));
    const graceRequest = newId(ID_PREFIXES.request);
    const graceCancel = await accept<CancelDetails>("sprout_remote_execution_cancel", {
      machineId,
      executionId: graceTarget.executionId,
      requestId: graceRequest,
      authorizationGeneration: generation,
      policy: "term_then_kill",
      termWaitMs: 10000,
    });
    assert(!graceCancel.stopped, "a 10s grace cancel is still only an intent");
    const graceStates: string[] = [graceCancel.cancellation.state];
    const graceStartedAt = Date.now();
    await until(
      async () => {
        const view = await getView(graceTarget.executionId);
        const state = view.cancellation?.state ?? "none";
        if (graceStates.at(-1) !== state) graceStates.push(state);
        return state === "exited_observed" || state === "failed" || state === "unknown";
      },
      "10s grace cancel settled",
      60000,
    );
    const graceSettledMs = Date.now() - graceStartedAt;
    const graceFinal = await getView(graceTarget.executionId);
    // 这条命令忽略 TERM 且永远跑不完：KILL 在 10 秒宽限后才到。合法宽限的性质是「宽限走完就
    // 给出取消终态，不被确认窗口抢先判成 delivery_unconfirmed」；信号只打命令组，runner 落盘，
    // 所以宽限结束时退出同样是被观测到的。
    assert.equal(
      graceFinal.cancellation?.state,
      "exited_observed",
      `a legal 10s grace must observe the killed command, not ${graceFinal.cancellation?.state}`,
    );
    assert.equal(graceFinal.cancellation?.failureReason, null);
    assert.notEqual(
      graceFinal.cancellation?.exitedAt,
      null,
      "a durable result carries the exit time",
    );
    assert.notEqual(graceFinal.terminalAt, null, "the execution reaches a terminal state");
    assert.notEqual(graceFinal.state, "running", "the execution does not stay running");
    assert.equal(graceFinal.state, "failed", "a killed command must not read as success");
    assert.equal(
      graceFinal.failureReason,
      "cancelled",
      "the reason is the cancel, not a revocation",
    );
    assert.equal(processCount(graceMarker), 0, "the killed command group leaves nothing behind");
    assert.ok(graceSettledMs < 60000, `settled within the derived window (${graceSettledMs}ms)`);
    facts.scenario6b = {
      executionId: graceTarget.executionId,
      pid: Number(gracePid),
      termWaitMs: 10000,
      cancelStates: graceStates,
      settledMs: graceSettledMs,
      finalExecutionState: graceFinal.state,
      terminalAt: graceFinal.terminalAt,
    };
    pass(
      "S6b",
      "S6b a legal 10s TERM grace ends in exited_observed inside the derived window (never delivery_unconfirmed)",
    );

    // —— 场景 6c：runner 缺席是唯一还该停在「未确认」的情况。 ——
    // 命令收到取消后杀掉自己的观察者（`kill -9 $PPID`）：磁盘上永远不会出现 result.json，
    // 于是「进程已不在、退出没有被记录」只能诚实说成未确认，不写已停止也不猜退出码。
    // 这是新规则的反证：exited_observed 不是把未确认态整体删掉。
    const absentMarker = markerOf();
    const absentSentinel = join(directory, "absent-runner-sentinel");
    rmSync(absentSentinel, { force: true });
    const absentTarget = (
      await submitShell({
        requestId: newId(ID_PREFIXES.request),
        command: `echo pid=$$; : ${absentMarker}; trap '' TERM; while [ ! -f '${absentSentinel}' ]; do sleep 0.2; done; kill -9 $PPID; sleep 60`,
        waitMs: 1000,
      })
    ).data;
    await until(
      async () => (await getView(absentTarget.executionId)).state === "running",
      "absent-runner command running",
      30000,
    );
    const absentPid = (await readLog(absentTarget.executionId, null, 4096)).frames
      .map((frame) => /pid=(\d+)/.exec(frame.text ?? "")?.[1])
      .find(Boolean);
    assert(absentPid, "absent-runner command pid");
    childrenPids.add(Number(absentPid));
    const absentCancel = await accept<CancelDetails>("sprout_remote_execution_cancel", {
      machineId,
      executionId: absentTarget.executionId,
      requestId: newId(ID_PREFIXES.request),
      authorizationGeneration: generation,
      policy: "term_then_kill",
      termWaitMs: 2000,
    });
    assert(!absentCancel.stopped, "a cancel intent is not a stop");
    await until(
      async () => (await getView(absentTarget.executionId)).cancellation?.state === "delivered",
      "absent-runner cancel delivered",
      40000,
    );
    // 确定性：只有意图已经送达，才让命令动手杀掉 runner。不靠时序窗口碰运气。
    writeFileSync(absentSentinel, "go", { mode: 0o600 });
    await until(
      async () => {
        const state = (await getView(absentTarget.executionId)).cancellation?.state;
        return state === "failed" || state === "unknown" || state === "exited_observed";
      },
      "absent-runner cancel settled",
      60000,
    );
    const absentFinal = await getView(absentTarget.executionId);
    assert.equal(
      absentFinal.cancellation?.state,
      "failed",
      "without a runner result a cancel must not claim an observed exit",
    );
    assert.equal(absentFinal.cancellation?.failureReason, "exit_not_observed");
    assert.equal(absentFinal.cancellation?.exitedAt, null, "no exit time without a durable result");
    assert.equal(absentFinal.state, "unknown");
    assert.equal(absentFinal.recoveryReason, "child-exited-without-result");
    assert.notEqual(absentFinal.state, "succeeded", "a killed observer must not read as success");
    const absentPayload = absentFinal.result as {
      kind: string;
      failureReason?: string;
      partial?: { exited?: boolean };
    };
    assert.equal(absentPayload.kind, "shell");
    assert.equal(absentPayload.failureReason, "worker_lost");
    assert.equal(absentPayload.partial?.exited, false, "no exit code is invented");
    facts.scenario6c = {
      executionId: absentTarget.executionId,
      pid: Number(absentPid),
      cancelState: absentFinal.cancellation?.state,
      failureReason: absentFinal.cancellation?.failureReason,
      finalExecutionState: absentFinal.state,
      recoveryReason: absentFinal.recoveryReason,
    };
    pass(
      "S6c",
      "S6c a missing runner is the only honest unknown: failed/exit_not_observed with no invented exit",
    );

    // —— 场景 7：人类在 Web 侧取消；未登录与另一用户被拒。 ——
    const humanMarker = markerOf();
    const humanTarget = (
      await submitShell({
        requestId: newId(ID_PREFIXES.request),
        command: `echo pid=$$; : ${humanMarker}; i=0; while [ $i -lt 30 ]; do echo tick=$i; sleep 1; done`,
        waitMs: 1000,
      })
    ).data;
    await until(
      async () => (await getView(humanTarget.executionId)).state === "running",
      "human cancel target running",
      30000,
    );
    const humanPid = /pid=(\d+)/.exec(
      (await readLog(humanTarget.executionId, null, 4096)).frames
        .map((frame) => frame.text ?? "")
        .join(""),
    )?.[1];
    assert(humanPid, "human cancel target pid");
    childrenPids.add(Number(humanPid));
    const humanRequest = newId(ID_PREFIXES.request);
    const raw = { executionId: humanTarget.executionId, requestId: humanRequest };
    const anonymous = await control("human_cancel", { raw, requestId: newId(ID_PREFIXES.request) });
    assert.equal(anonymous.result?.ok, false);
    const anonymousCode = anonymous.result?.ok === false ? anonymous.result.error.code : "ok";
    assert.equal(anonymousCode, "unauthorized");
    const stranger = await control("human_cancel", {
      raw,
      cookie: otherCookie,
      requestId: newId(ID_PREFIXES.request),
    });
    const strangerCode = stranger.result?.ok === false ? stranger.result.error.code : "ok";
    assert.equal(strangerCode, "not_found", "another user cannot cancel");
    const human = await control("human_cancel", {
      raw,
      cookie,
      requestId: newId(ID_PREFIXES.request),
    });
    assert(human.result?.ok, "the owner session can cancel");
    const humanView = human.result!.data as CancelView;
    assert.equal(humanView.executionId, humanTarget.executionId);
    const humanStates: string[] = [humanView.state];
    await until(
      async () => {
        const view = await getView(humanTarget.executionId);
        const state = view.cancellation?.state ?? "none";
        if (humanStates.at(-1) !== state) humanStates.push(state);
        return state === "exited_observed" || state === "failed" || state === "unknown";
      },
      "human cancel settled",
      60000,
    );
    const humanFinal = await getView(humanTarget.executionId);
    const humanRow = sqlite
      .prepare("SELECT actor_kind,actor_id FROM execution_cancellation WHERE execution_id=?")
      .get(humanTarget.executionId) as { actor_kind: string; actor_id: string };
    assert.equal(humanRow.actor_kind, "human", "human cancel records the human actor");
    assert.equal(humanRow.actor_id, userId);
    assert.equal(humanFinal.cancellation?.state, "exited_observed");
    assert.equal(humanFinal.state, "failed", "a human-cancelled command ends as a failed terminal");
    assert.equal(humanFinal.failureReason, "cancelled", "the human cancel is the stated reason");
    facts.scenario7 = {
      executionId: humanTarget.executionId,
      pid: Number(humanPid),
      cancelStates: humanStates,
      actorKind: humanRow.actor_kind,
      actorIsOwner: humanRow.actor_id === userId,
      finalExecutionState: humanFinal.state,
      signalOutcome: humanFinal.cancellation?.signalOutcome,
      anonymousCode,
      strangerCode,
    };
    pass(
      "S7",
      "S7 human Web cancel is authorised on the server boundary and records the human actor",
    );
  }
  if (includes("recovery")) {
    // —— 场景 12：断线期间产生真实终态，同一 Worker 会话重连后由 durable 上行补送。 ——
    // 提交命令必须由租约持有者的实例发出：沿用同一条真实 run 和既有的真实 grant。
    useGrant(issued.grant);
    const offlineMarker = markerOf();
    const offlineGate = join(directory, "offline-gate");
    const offline = (
      await withActiveRun(actor.runId, () =>
        submitShell({
          requestId: newId(ID_PREFIXES.request),
          command: `echo pid=$$; while [ ! -f '${offlineGate}' ]; do sleep 0.2; done; echo offline-terminal; : ${offlineMarker}`,
          waitMs: 1000,
        }),
      )
    ).data;
    await until(
      async () =>
        (await withActiveRun(actor.runId, () => getView(offline.executionId))).state === "running",
      "offline target running",
      30000,
    );
    const offlineLog = await withActiveRun(actor.runId, () =>
      readLog(offline.executionId, null, 4096),
    );
    const offlinePid = Number(
      /pid=(\d+)/.exec(offlineLog.frames.map((frame) => frame.text ?? "").join(""))![1],
    );
    childrenPids.add(offlinePid);
    // 冻结服务进程而不是重启：bootId 不变，Worker 的会话仍然有效，重连是同一会话。
    assert(service?.pid, "service process required");
    process.kill(service.pid, "SIGSTOP");
    writeFileSync(offlineGate, "go");
    await until(() => !alive(offlinePid), "the command exits while the service is frozen", 30000);
    await sleep(4000);
    process.kill(service.pid, "SIGCONT");
    await until(
      async () =>
        (await withActiveRun(actor.runId, () => getView(offline.executionId))).terminalAt !== null,
      "offline terminal delivered after the same-session reconnect",
      90000,
    );
    const offlineFinal = await withActiveRun(actor.runId, () => getView(offline.executionId));
    assert.equal(offlineFinal.state, "succeeded", "the observed exit must reconcile the row");
    const offlineResult = offlineFinal.result as {
      recovered?: boolean;
      exitCode?: number;
      stdout?: string;
    } | null;
    assert.equal(
      offlineResult?.recovered ?? false,
      false,
      "the resent native report is not a recovery guess",
    );
    assert.equal(offlineResult?.exitCode, 0);
    assert((offlineResult?.stdout ?? "").includes("offline-terminal"));
    assert.equal(processCount(offlineMarker), 0, "the command must not be re-run");
    facts.scenario12 = {
      executionId: offline.executionId,
      pid: offlinePid,
      exitedWhileServiceFrozen: true,
      stateAfterReconnect: offlineFinal.state,
      nativeResult: !(offlineResult?.recovered ?? false),
      exitCode: offlineResult?.exitCode ?? null,
      stdoutHasMarker: (offlineResult?.stdout ?? "").includes("offline-terminal"),
      implicitRerun: false,
    };
    pass(
      "S12",
      "S12 a real exit produced during the outage is resent natively on the same Worker session",
    );

    // —— 场景 9：命令运行中服务进程重启。 ——
    const restartMarker = markerOf();
    const restartRelease = join(directory, `${restartMarker}.release`);
    completionFiles.add(restartRelease);
    const restartTarget = (
      await submitShell({
        requestId: newId(ID_PREFIXES.request),
        command: `echo pid=$$; : ${restartMarker}; echo f=0; deadline=$(($(date +%s)+300)); while [ ! -e '${restartRelease}' ]; do [ $(date +%s) -lt $deadline ] || exit 124; sleep 0.15; done; echo f=complete`,
        waitMs: 1000,
      })
    ).data;
    await until(
      async () => (await getView(restartTarget.executionId)).state === "running",
      "server restart target running",
      30000,
    );
    const restartLog = await readLog(restartTarget.executionId, null, 4096);
    assert(restartLog.frames.length > 0, "log frames persisted before the restart");
    const restartPid = /pid=(\d+)/.exec(
      restartLog.frames.map((frame) => frame.text ?? "").join(""),
    )?.[1];
    assert(restartPid, "server restart target pid");
    childrenPids.add(Number(restartPid));
    await stop(service);
    assert(alive(Number(restartPid)), "a service restart must not kill the command process");
    service = launch(
      ["--import", "tsx", "tests/fixtures/execution-live-service.ts"],
      "service-restart.log",
      true,
    );
    await healthy(90000);
    // 服务重启后真实产品沿用同一 chat 与同一 agent instance，只新建一条 run 与 grant。
    // 换 instance 等于换执行归属者，不能代表重启后的会话（F1 的 holder 规则会拒读）。
    const restartRunId = `run_${randomUUID()}`;
    sqlite
      .prepare(
        "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
      )
      .run(
        restartRunId,
        actor.instanceId,
        actor.chatId,
        projectId,
        newId(ID_PREFIXES.request),
        Math.floor(Date.now() / 1000),
        randomBytes(16).toString("hex"),
      );
    const secondGrant = await control("issue", { runId: restartRunId });
    assert(secondGrant.ok && secondGrant.grant, "post-restart grant for the same instance");
    useGrant(secondGrant.grant);
    const afterRestart = await withActiveRun(restartRunId, () =>
      getView(restartTarget.executionId),
    );
    assert.equal(afterRestart.requestId, restartTarget.requestId, "facts survive the restart");
    assert.equal(afterRestart.createdAt, restartTarget.createdAt);
    // 宿主重启不产生终态：命令可能还在跑，结果也可能已经落盘，只有 Worker 的归约事实能收尾。
    assert.equal(afterRestart.terminalAt, null, "a boot change must not terminalise the execution");
    assert.equal(
      afterRestart.state,
      "running",
      "the execution stays non-terminal across the restart",
    );
    assert.equal(processCount(restartMarker), 1, "a server restart must not re-dispatch");
    const persistedLog = await withActiveRun(restartRunId, () =>
      readLog(restartTarget.executionId, null, 4096),
    );
    assert(
      persistedLog.frames.length >= restartLog.frames.length,
      "pre-restart frames stay readable",
    );
    assert(alive(Number(restartPid)), "the original command waits through post-restart checks");
    writeFileSync(restartRelease, "release", { mode: 0o600 });
    await until(
      async () =>
        (await withActiveRun(restartRunId, () => getView(restartTarget.executionId))).terminalAt !==
        null,
      "restart target settles",
      120000,
    );
    const restartFinal = await withActiveRun(restartRunId, () =>
      getView(restartTarget.executionId),
    );
    const restartRows = (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM remote_execution WHERE request_id=?")
        .get(restartTarget.requestId) as { n: number }
    ).n;
    assert.equal(restartRows, 1, "one requestId still has exactly one execution");
    assert(
      restartFinal.state === "succeeded" ||
        restartFinal.state === "failed" ||
        restartFinal.state === "unknown",
    );
    facts.scenario9 = {
      executionId: restartTarget.executionId,
      pid: Number(restartPid),
      childAliveWhileServiceDown: true,
      stateAfterRestart: afterRestart.state,
      requestIdPreserved: true,
      preRestartFrames: restartLog.frames.length,
      postRestartFrames: persistedLog.frames.length,
      finalState: restartFinal.state,
      recovered: (restartFinal.result as { recovered?: boolean } | null)?.recovered ?? false,
      executionsForRequest: restartRows,
      implicitRerun: false,
    };
    pass(
      "S9",
      "S9 a service restart keeps the same facts, reports unknown, and never re-runs the command",
    );

    await until(
      async () => (await getView(disconnect.executionId)).terminalAt !== null,
      "primary execution settles after the Worker restart",
      90000,
    );
    const settled = await getView(disconnect.executionId);
    assert(
      settled.state === "succeeded" || settled.state === "failed" || settled.state === "unknown",
      `settled state must be an observed fact, saw ${settled.state}`,
    );
    const settledRecovered = (settled.result as { recovered?: boolean } | null)?.recovered;
    // 重启后的行要么由恢复事实归约（必须带 recovered 标记），要么停在 worker_lost 的 unknown。
    if (settled.state === "succeeded" || settled.state === "failed")
      assert.equal(settledRecovered, true, "a settled state must be labelled as recovered");
    else {
      assert.equal(settled.state, "unknown");
      assert.equal(settled.failureReason, "worker_lost");
      assert.equal(settled.result, null, "unknown without a result must not invent one");
    }
    facts.scenario5Terminal = {
      state: settled.state,
      failureReason: settled.failureReason,
      recovered: settledRecovered ?? false,
      logState: settled.logState,
      producedThroughSequence: settled.producedThroughSequence,
    };
    pass(
      "S5",
      "S5 the reconnected Worker only reports observed recovery facts for the surviving process",
    );
  }
  validateAhCoverage(group, checks);
  completed = true;
} finally {
  await cleanup();
  writeEvidence();
  console.log(`evidence: ${evidencePath}`);
}
