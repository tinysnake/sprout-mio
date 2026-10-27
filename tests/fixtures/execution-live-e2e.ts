// I-P4c 真实端到端：真实 macOS Worker、真实服务、真实 SQLite、真实 agent 工具面。
// 工具调用走 production 的 registerRemoteTools + createRemoteClient（与 Pi host 同一接线），
// 断线/重启/取消都作用在真实子进程上。命令正文、日志正文、cookie、token 都不进证据文件。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ExecutionView, RemoteToolGrant } from "../../src/contracts/remote";
import type { AppResult } from "../../src/contracts/result";
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
const directory = mkdtempSync(resolve(".verify/ah-execution-live-"));
const evidencePath = join(directory, "evidence.json");
const children: ReturnType<typeof spawn>[] = [];
const checks: string[] = [];
const facts: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const pass = (name: string) => {
  checks.push(name);
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
  const log = join(directory, name);
  const fd = openSync(log, "w", 0o600);
  const child = spawn(process.execPath, args, {
    env,
    stdio: ipc ? ["ignore", fd, fd, "ipc"] : ["ignore", fd, fd],
  });
  closeSync(fd);
  children.push(child);
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
  nextCursor: { nextSequence: number };
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
  cursor: { nextSequence: number } | null,
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
      .prepare("UPDATE agent_run SET status='running',started_at=COALESCE(started_at,?) WHERE id=?")
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
/**
 * 宿主下发的 shell 命令没有 max_runtime_ms 入参（属于 p4c-tools / p4c-execution）。
 * 本脚本在真实 Worker 与真实服务之间加一个只改这一字段的代理：给每条 shell 命令补上
 * 运行上限，其余字节原样转发。没有运行上限时 Worker 走 P4b 短操作语义，waitMs 到点就
 * 交终态，长命令根本无法被观察，也无法取消。
 */
const proxyPort = await freePort([port]);
const workerBase = `http://127.0.0.1:${proxyPort}`;
const proxy = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    const body = Buffer.concat(chunks);
    const upstream = await fetch(base + request.url!, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const text = await upstream.text();
    if (request.url === "/api/worker/exchange" && upstream.ok) {
      try {
        const parsed = JSON.parse(text) as {
          data?: { remote?: { commands?: Record<string, unknown>[] } };
        };
        let changed = false;
        for (const command of parsed.data?.remote?.commands ?? []) {
          if (
            command.operation &&
            (command.operation as { kind?: string }).kind === "shell" &&
            command.maxRuntimeMs === null
          ) {
            Object.assign(command, {
              maxRuntimeMs: 180000,
              runtimeDeadlineAt: new Date(Date.now() + 180000).toISOString(),
            });
            changed = true;
          }
        }
        if (changed) {
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(JSON.stringify(parsed));
          return;
        }
      } catch {}
    }
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    response.end(text);
  } catch {
    response.writeHead(502);
    response.end();
  }
});
await new Promise<void>((res) => proxy.listen(proxyPort, "127.0.0.1", res));

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
  pass("real production service, isolated SQLite and two new accounts");

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
  pass("real remote tool surface registered against the production service");

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
  pass("real macOS Worker enrolled and streaming into the production service");

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
  pass("S1 executionId maps to a real child process started by this execution");

  const beforeDedupe = await getView(primary.executionId);
  const replayed = await submitShell({ requestId, command });
  assert.equal(
    replayed.data.executionId,
    primary.executionId,
    "same requestId reuses the execution",
  );
  assert.equal(processCount(marker), 1, "only one real child process for the same requestId");
  const afterDedupe = await getView(primary.executionId);
  assert.equal(afterDedupe.dispatchSeq, beforeDedupe.dispatchSeq, "dedupe must not dispatch again");
  facts.scenario2 = {
    executionId: primary.executionId,
    requestId,
    dispatchSeqBefore: beforeDedupe.dispatchSeq,
    dispatchSeqAfter: afterDedupe.dispatchSeq,
    processCount: processCount(marker),
  };
  pass("S2 repeated requestId returns the same execution without a second dispatch");

  // 游标：小预算分页读到 line=5，序号单调、不重复、nextCursor 推进。
  const pages: { cursor: number; sequences: number[]; nextCursor: number }[] = [];
  let cursor: { nextSequence: number } | null = null;
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
    if (cursor) assert(view.nextCursor.nextSequence >= cursor.nextSequence, "nextCursor advances");
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
  const idempotentCursor = { nextSequence: pages[1]!.nextCursor };
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
  const cross = await readLog(shortExecution.executionId, { nextSequence: 40 }, 4096);
  facts.scenario3 = {
    pages: pages.length,
    sequencesMonotonic: true,
    reachedLine5: true,
    idempotentFrames: idempotent.frames.length,
    crossCursor: {
      executionFrom: primary.executionId,
      executionTo: shortExecution.executionId,
      cursor: 40,
      outcome: cross.outcome,
      frameCount: cross.frames.length,
      logState: cross.logState,
      rejected: false,
    },
  };
  pass("S3 cursor paging is monotonic, idempotent, and its cross-execution behaviour is recorded");

  // —— 场景 4/10：超出单次读取预算的输出，逐页读全；保留裁剪按实现记录。 ——
  const bigRequest = newId(ID_PREFIXES.request);
  const big = (
    await submitShell({
      requestId: bigRequest,
      command:
        "i=0; while [ $i -lt 3000 ]; do printf 'x%07d-0123456789abcdefghijklmnopqrstuvwxyz\\n' \"$i\"; i=$((i+1)); done",
    })
  ).data;
  await until(
    async () => (await getView(big.executionId)).terminalAt !== null,
    "big output terminal",
    60000,
  );
  const bigFinal = await getView(big.executionId);
  const allSequences: number[] = [];
  let bigCursor: { nextSequence: number } | null = null;
  let firstPageRemaining: number | null = null;
  for (let page = 0; page < 80; page++) {
    const view = await readLog(big.executionId, bigCursor, 16384);
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
    unique,
    [...unique].sort((a, b) => a - b),
    "paged read stays ordered",
  );
  assert.equal(unique.length, bigFinal.producedThroughSequence, "every produced frame is readable");
  const finalLog = await readLog(big.executionId, null, 65536);
  assert.equal(finalLog.availableFromSequence, null, "host currently never trims the log");
  assert.notEqual(finalLog.logState, "truncated");
  assert(firstPageRemaining !== null && firstPageRemaining > 0, "one page cannot hold the output");
  facts.scenario4 = {
    executionId: big.executionId,
    requestId: bigRequest,
    producedThroughSequence: bigFinal.producedThroughSequence,
    framesRead: unique.length,
    pagesNeeded: allSequences.length > 0,
    firstPageFramesRemaining: firstPageRemaining,
    logState: finalLog.logState,
    availableFromSequence: finalLog.availableFromSequence,
    retentionTruncationReachable: false,
  };
  facts.scenario10 = {
    fixedRetentionRule: "host 无 available_from_seq 写入路径；无裁剪发生，故不存在静默丢失",
    earlyStopDetectable: firstPageRemaining !== null && firstPageRemaining > 0,
  };
  pass("S4/S10 the real log is read in full across pages and no silent trim claims completeness");

  // —— 场景 5/8：命令运行中 Worker 掉线并重启。 ——
  const disconnectMarker = markerOf();
  const disconnect = (
    await submitShell({
      requestId: newId(ID_PREFIXES.request),
      command: `echo pid=$$; : ${disconnectMarker}; i=0; while [ $i -lt 20 ]; do echo d=$i; sleep 1; done`,
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
  const unknownObservation: { state?: string; failureReason?: string | null } = {};
  await until(
    async () => {
      const view = await getView(disconnect.executionId);
      if (view.state === "unknown") {
        unknownObservation.state = view.state;
        unknownObservation.failureReason = view.failureReason;
        return true;
      }
      return false;
    },
    "execution becomes unknown while the Worker is gone",
    60000,
  );
  assert.equal(unknownObservation.state, "unknown");
  assert.equal(processCount(disconnectMarker), 1, "unknown must not re-run the command");
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
    { nextSequence: cursorBeforeDrop.nextCursor.nextSequence },
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
  assert.equal(afterRestartExecutions, beforeRestartExecutions, "no implicit re-run on reconnect");
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
    stateWhileWorkerDown: unknownObservation.state,
    failureReasonWhileWorkerDown: unknownObservation.failureReason,
    processCountWhileDown: processCount(disconnectMarker),
    pidBeforeRestart: disconnectPid,
    pidAfterRestart: disconnectPid,
    implicitRerun: false,
  };
  pass("S8 a Worker restart makes the execution unknown without re-running the command");

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
  assert.equal(cancelled.cancellation?.state, "exited_observed", "cancel must observe the exit");
  // 取消导致的退出不得被伪造成成功：结果只报 partial 与授权撤销原因，取消事实单独记录。
  assert.notEqual(cancelled.state, "succeeded", "a cancelled command must not read as success");
  assert(cancelled.result !== null, "the observed exit keeps a result payload");
  const cancelPayload = cancelled.result as {
    kind: string;
    failureReason?: string;
    partial?: { exited?: boolean };
  };
  assert.equal(cancelPayload.kind, "shell");
  assert.equal(cancelPayload.failureReason, "authorization_revoked");
  assert.notEqual(cancelled.cancellation.signalOutcome, "none", "the signal delivery is recorded");
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
  pass("S6 agent cancel goes requested → delivered → exited_observed without faking a stop");

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
  assert.notEqual(
    humanFinal.state,
    "succeeded",
    "a human-cancelled command must not read as success",
  );
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
  pass("S7 human Web cancel is authorised on the server boundary and records the human actor");

  // —— 场景 9：命令运行中服务进程重启。 ——
  const restartMarker = markerOf();
  const restartTarget = (
    await submitShell({
      requestId: newId(ID_PREFIXES.request),
      command: `echo pid=$$; : ${restartMarker}; i=0; while [ $i -lt 20 ]; do echo f=$i; sleep 1; done`,
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
  const bootId2 = (
    sqlite.prepare("SELECT id FROM runtime_boot ORDER BY started_at DESC LIMIT 1").get() as {
      id: string;
    }
  ).id;
  const secondActor = seedRemoteActor(sqlite, userId, projectId, bootId2, false);
  sqlite
    .prepare("UPDATE agent_run SET status='queued',started_at=NULL WHERE id=?")
    .run(secondActor.runId);
  const secondGrant = await control("issue", { runId: secondActor.runId });
  assert(secondGrant.ok && secondGrant.grant, "post-restart grant for a new instance");
  useGrant(secondGrant.grant);
  const afterRestart = await withActiveRun(secondActor.runId, () =>
    getView(restartTarget.executionId),
  );
  assert.equal(afterRestart.requestId, restartTarget.requestId, "facts survive the restart");
  assert.equal(afterRestart.createdAt, restartTarget.createdAt);
  assert.equal(afterRestart.state, "unknown", "a boot change makes the execution unconfirmable");
  assert.equal(processCount(restartMarker), 1, "a server restart must not re-dispatch");
  const persistedLog = await withActiveRun(secondActor.runId, () =>
    readLog(restartTarget.executionId, null, 4096),
  );
  assert(
    persistedLog.frames.length >= restartLog.frames.length,
    "pre-restart frames stay readable",
  );
  await until(
    async () =>
      (await withActiveRun(secondActor.runId, () => getView(restartTarget.executionId)))
        .terminalAt !== null,
    "restart target settles",
    120000,
  );
  const restartFinal = await withActiveRun(secondActor.runId, () =>
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
  pass("S9 a service restart keeps the same facts, reports unknown, and never re-runs the command");
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
  pass("S5 the reconnected Worker only reports observed recovery facts for the surviving process");
} finally {
  for (const pid of childrenPids) if (alive(pid)) process.kill(pid, "SIGKILL");
  if (service?.connected) await control("cleanup").catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  await new Promise<void>((res) => proxy.close(() => res()));
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        ok: checks.length,
        checks,
        facts,
        artifacts: { directory, logs: children.length },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`evidence: ${evidencePath}`);
}
