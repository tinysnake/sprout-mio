/**
 * P8d 集成线真实 Windows 端到端：走**生产执行路径** `RemoteDispatcher`，而不是直接 spawn runner。
 *
 * `p8d-windows-worker.ts` 验的是平台适配（探测、runner、进程树）；这里验的是功能线与 UI 线
 * 在 macOS 自测时都没覆盖的那条链路：命令准入 → runner → 结果归约 → 终态报告，外加文件操作、
 * 进程枚举与树终止、取消、重连去重、未观测退出与重启恢复。
 *
 * 用法：node p8d-windows-integration.mjs [expectSessionId]
 * 产物：PASS/UNVERIFIED 行 + 最后一行 `P8D_WINDOWS_INTEGRATION_OK {json}`；断言失败抛错并退出非零码。
 *
 * 本机协议冒烟（在 macOS 上验帧形状与去重/恢复语义，**不代替** Windows 验收）：
 *   P8D_INTEGRATION_SMOKE=1 node p8d-windows-integration.mjs → 末尾 `P8D_INTEGRATION_SMOKE_OK`。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { CapabilitySnapshot, ShellFact } from "../../src/contracts/machine";
import type { RemoteCommand } from "../../src/contracts/remote";
import type { WorkerExchangeResponse } from "../../src/contracts/worker";
import type { WorkerSession } from "../../src/contracts/worker-session";
import { ExecutionRegistry, ExecutionStore } from "../../src/worker/executions";
import {
  executionSessionKind,
  killProcessTree,
  parseTasklistCsv,
  processTreeKillIsForced,
} from "../../src/worker/platform";
import { probeCapability } from "../../src/worker/probes";
import { RemoteDispatcher } from "../../src/worker/remote";

type Frame = Parameters<RemoteDispatcher["accept"]>[0];
/** 宿主 → Worker 的一帧远端载荷（命令、取消、ACK）。 */
type RemoteWireInput = Extract<WorkerExchangeResponse, { ok: true }>["data"]["remote"];
/** Worker → 宿主的上行载荷（结果与恢复事实）。 */
type RemoteWireOutput = ReturnType<RemoteDispatcher["outgoing"]>;
type RemoteWireReport = RemoteWireOutput["results"][number];
type TerminalReport = Extract<RemoteWireReport, { phase: "terminal" }>;
type Cancellation = NonNullable<RemoteWireInput["cancellations"]>[number];
/**
 * 终态载荷是判别联合，而且成功与失败的 shell 载荷都带 `kind: "shell"`：读字段用结构化视图，
 * 缺少的字段一律视为 undefined，断言自然不会因为「形状变了」而静默通过。
 */
type PayloadView = {
  kind: string;
  failureReason?: string;
  partial?: PayloadView;
  pid?: number;
  exited?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  content?: string;
  bytesWritten?: number;
  items?: { pid: number; command: string }[];
  delivered?: boolean;
};
function payloadOf(report: TerminalReport, kind: string): PayloadView {
  const payload = report.payload as unknown as PayloadView;
  assert(payload.kind === kind, `expected a ${kind} payload, got ${String(payload.kind)}`);
  return payload;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const isWindows = process.platform === "win32";
const SMOKE = process.env.P8D_INTEGRATION_SMOKE === "1" && !isWindows;
let passed = 0;
const unverified: string[] = [];
function pass(name: string, detail = "") {
  passed++;
  console.log(`PASS ${name}${detail ? ` ${detail}` : ""}`);
}
function skipWindowsOnly(name: string) {
  console.log(`SKIP ${name} (win32-only)`);
}
/** 不可验证的项既不算通过也不算失败：显式登记，由报告逐条说明缺什么环境。 */
function unverify(name: string, evidence: string) {
  unverified.push(name);
  console.log(`UNVERIFIED ${name} ${evidence}`);
}
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function fileLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}
/** 同步存活探测：只在收尾与进程树断言里用，不参与被测语义。 */
function pidAliveSync(pid: number): boolean {
  if (isWindows) {
    const probe = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    });
    return parseTasklistCsv(`${probe.stdout ?? ""}${probe.stderr ?? ""}`).some(
      (item) => item.pid === pid,
    );
  }
  const probe = spawnSync("ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" });
  return probe.status === 0 && `${probe.stdout ?? ""}`.trim().length > 0;
}
/** 收尾用的定点清理：POSIX 上 killProcessTree 要求 pid 是进程组长，这里退回单 pid 信号。 */
function killPid(pid: number) {
  if (isWindows || killProcessTree(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已经退出即目标状态。
  }
}
function successfulShells(capability: CapabilitySnapshot): ShellFact[] {
  return capability.shells.filter((fact) => fact.probe.kind === "success");
}
function shellText(kind: ShellFact["kind"], marker: string): string {
  if (kind === "pwsh" || kind === "powershell") return `Write-Output ${marker}`;
  return `echo ${marker}`;
}
function startText(kind: ShellFact["kind"], markerFile: string, seconds: number): string {
  // cmd.exe 不解析 libuv 转义出来的 \"，所以 cmd 的命令正文里不能出现双引号：
  // 临时目录必须无空格，路径直接裸写（下面有断言保证）。
  if (kind === "cmd") return `echo tick>> ${markerFile} & ping -n ${seconds} 127.0.0.1 > nul`;
  if (kind === "pwsh" || kind === "powershell")
    return `Add-Content -LiteralPath '${markerFile}' -Value tick; Start-Sleep -Seconds ${seconds}`;
  return `echo tick >> '${markerFile}'; sleep ${seconds}`;
}
function sleepText(kind: ShellFact["kind"], seconds: number): string {
  if (kind === "cmd") return `ping -n ${seconds} 127.0.0.1 > nul`;
  if (kind === "pwsh" || kind === "powershell") return `Start-Sleep -Seconds ${seconds}`;
  return `sleep ${seconds}`;
}

// ---------------------------------------------------------------- 运行环境

assert(
  isWindows || SMOKE,
  `只能跑在真实 Windows 上；本机是 ${process.platform}。本机协议冒烟请设 P8D_INTEGRATION_SMOKE=1。`,
);
const expectSession = process.argv[2] ? Number(process.argv[2]) : null;
const work = mkdtempSync(join(tmpdir(), "sprout-p8d-int-"));
assert(!work.includes(" "), `临时目录不能含空格（cmd 重定向无法加引号）：${work}`);
const strayPids: number[] = [];
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: P8d 集成验收超过 300 秒，强制退出");
  process.exit(70);
}, 300_000);
watchdog.unref();

const capability = await probeCapability(now());
const projectId = newId(ID_PREFIXES.project);
const machineId = newId(ID_PREFIXES.machine);
const holderInstanceId = newId(ID_PREFIXES.instance);
const key = { projectId, machineId, holderInstanceId };
const session: WorkerSession = {
  machineId,
  generation: 1,
  bootId: newId(ID_PREFIXES.boot),
  attemptId: randomUUID(),
};
const stateDirectory = join(work, "state");
mkdirSync(stateDirectory, { recursive: true });
const registry = new ExecutionRegistry(new ExecutionStore(stateDirectory), Date.now);
const dispatcher = new RemoteDispatcher(
  session,
  capability,
  Date.now,
  undefined as never,
  registry,
);

let seq = 0;
let lastFrame: Frame | null = null;
function wire(commands: RemoteCommand[], extra: Partial<RemoteWireInput> = {}): RemoteWireInput {
  return {
    commands,
    authorizations: [{ ...key, generation: 1, state: "active" }],
    fences: [],
    resultAcks: [],
    fenceAcks: [],
    logAcks: [],
    mcp: [],
    mcpCursors: [],
    ...extra,
  };
}
/** 投递一帧；`remap` 把命令的 dispatchSeq 对齐到本帧序号（正常投递的必然后置条件）。 */
function apply(commands: RemoteCommand[], extra: Partial<RemoteWireInput> = {}, remap = true) {
  seq++;
  const body = remap ? commands.map((command) => ({ ...command, dispatchSeq: seq })) : commands;
  lastFrame = {
    mode: "normal",
    session,
    seq,
    configuration: { root: null, rootRevision: 1, bindings: [] },
    remote: wire(body, extra),
  };
  dispatcher.accept(lastFrame, seq, []);
  return seq;
}
/** 原帧重发：同一 seq 的整帧重放（模拟 exchange 响应丢失后的重连）。 */
function replayLastFrame() {
  assert(lastFrame, "no frame to replay");
  dispatcher.accept(lastFrame, lastFrame.seq, []);
}
function command(operation: RemoteCommand["operation"], overrides: Partial<RemoteCommand> = {}) {
  return {
    ...key,
    executionId: newId(ID_PREFIXES.execution),
    requestId: newId(ID_PREFIXES.request),
    dispatchSession: session,
    dispatchSeq: seq,
    authorizationGeneration: 1,
    fingerprint: "a".repeat(64),
    directoryRevision: null,
    dispatchDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    runtimeDeadlineAt: null,
    maxRuntimeMs: null,
    runnerToken: "b".repeat(32),
    operation,
    ...overrides,
  } satisfies RemoteCommand;
}
function cancellation(executionId: string, overrides: Partial<Cancellation> = {}): Cancellation {
  return {
    cancelId: newId(ID_PREFIXES.cancellation),
    executionId,
    ...key,
    authorizationGeneration: 1,
    runnerToken: "b".repeat(32),
    policy: "term_then_kill",
    termWaitMs: 1000,
    ...overrides,
  };
}
function reportsFor(executionId: string): RemoteWireReport[] {
  return dispatcher.outgoing(1048576).results.filter((item) => item.executionId === executionId);
}
/** 等终态报告；`accept` 只对「快照已确认」放行，这里按断言条件继续等真实终态。 */ async function terminalOf(
  executionId: string,
  timeoutMs: number,
  label: string,
  accept: (report: TerminalReport) => boolean = () => true,
) {
  const matched = () =>
    reportsFor(executionId)
      .filter((item): item is TerminalReport => item.phase === "terminal")
      .find((item) => accept(item));
  await until(() => matched() !== undefined, timeoutMs, label);
  const hit = matched();
  assert(hit, `${label}: terminal report missing`);
  return hit;
}
const runnerFile = (executionId: string) =>
  join(stateDirectory, "executions", executionId, "runner.json");
const resultFile = (executionId: string) =>
  join(stateDirectory, "executions", executionId, "result.json");
async function childPidOf(executionId: string, timeoutMs = 15_000) {
  await until(
    () => {
      const claim = existsSync(runnerFile(executionId)) ? readJson(runnerFile(executionId)) : null;
      return typeof claim?.childPid === "number" && (claim.childPid as number) > 1;
    },
    timeoutMs,
    `runner.json childPid of ${executionId}`,
  );
  return readJson(runnerFile(executionId)).childPid as number;
}
/**
 * 生产路径的 shell 选择是「能力快照里第一个探测成功的 shell」：`RemoteDispatcher.execute`
 * 内部用的是 `capability.shells.find(success)`，命令本身不带 shell 字段。所以要让某一种 shell
 * 走完整生产链路，只能给它一份只含该 shell 的能力快照——这也正是只有一种 shell 的机器上
 * 产品的真实行为。每次用独立的 state dir，避免与主链路的事实相互污染。
 */
async function runShellOnTarget(target: ShellFact, text: string, waitMs = 8000) {
  const directory = join(work, `state-${target.kind}`);
  mkdirSync(directory, { recursive: true });
  const targetSession: WorkerSession = {
    machineId,
    generation: 1,
    bootId: newId(ID_PREFIXES.boot),
    attemptId: randomUUID(),
  };
  const targetDispatcher = new RemoteDispatcher(
    targetSession,
    { ...capability, shells: [target] },
    Date.now,
    undefined as never,
    new ExecutionRegistry(new ExecutionStore(directory), Date.now),
  );
  const targetCommand = command(
    { kind: "shell", command: text, cwd: work, waitMs },
    { dispatchSession: targetSession, dispatchSeq: 1 },
  );
  targetDispatcher.accept(
    {
      mode: "normal",
      session: targetSession,
      seq: 1,
      configuration: { root: null, rootRevision: 1, bindings: [] },
      remote: wire([targetCommand]),
    },
    1,
    [],
  );
  const deadline = Date.now() + 60_000;
  let report: TerminalReport | undefined;
  while (Date.now() < deadline) {
    report = targetDispatcher
      .outgoing(1048576)
      .results.filter((item): item is TerminalReport => item.phase === "terminal")
      .find((item) => item.executionId === targetCommand.executionId);
    if (report) break;
    await sleep(200);
  }
  assert(report, `${target.kind} produced no terminal report`);
  return {
    executionId: targetCommand.executionId,
    report,
    stateDirectory: directory,
  };
}

const facts: Record<string, unknown> = {};

try {
  // ---------------------------------------------------------------- 1) shell 探测与诚实性
  const shells = new Map(capability.shells.map((fact) => [fact.kind, fact]));
  const major = (fact: ShellFact) => Number.parseInt(fact.version?.split(".")[0] ?? "", 10);
  assert(capability.platform === process.platform, `capability platform ${capability.platform}`);
  const live = successfulShells(capability);
  assert(live.length > 0, `no shell probe succeeded: ${JSON.stringify(capability.shells)}`);
  // 主链路（不带独立能力快照的那些场景）用的 shell：生产规则是能力快照里第一个探测成功的
  // shell（`RemoteDispatcher.execute` 里的 `capability.shells.find(success)`）。
  const primaryShell = live[0]!;
  for (const fact of live) {
    assert(fact.path.length > 0, `${fact.kind} has empty path`);
    assert(fact.version !== null, `${fact.kind} reports no version`);
  }
  if (isWindows) {
    for (const kind of ["pwsh", "powershell", "cmd"] as const) {
      const fact = shells.get(kind);
      assert(fact, `capability does not report ${kind}`);
      assert(fact.probe.kind === "success", `${kind} probe failed: ${JSON.stringify(fact.probe)}`);
      assert(fact.path.includes("\\"), `${kind} path is not native: ${fact.path}`);
    }
    assert(major(shells.get("pwsh")!) >= 7, `pwsh major: ${shells.get("pwsh")!.version}`);
    assert(
      major(shells.get("powershell")!) === 5,
      `Windows PowerShell major: ${shells.get("powershell")!.version}`,
    );
    pass(
      "capability shells",
      ["pwsh", "powershell", "cmd"]
        .map((kind) => `${kind}=${shells.get(kind as ShellFact["kind"])!.version}`)
        .join(" "),
    );
  } else {
    pass("capability shells (smoke)", live.map((fact) => `${fact.kind}=${fact.version}`).join(" "));
  }

  // 诚实性反证：探测不到时必须报失败、不编造版本，`shell` 能力随之消失。
  if (isWindows) {
    const names = ["ProgramFiles", "SystemRoot", "ComSpec", "PATH"] as const;
    const saved = names.map((name) => process.env[name]);
    let blind: CapabilitySnapshot;
    try {
      const bogus = join(work, "no-such-toolchain");
      process.env.ProgramFiles = bogus;
      process.env.SystemRoot = bogus;
      process.env.ComSpec = join(bogus, "cmd.exe");
      process.env.PATH = bogus;
      blind = await probeCapability(now());
    } finally {
      names.forEach((name, index) => {
        const value = saved[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
    assert(blind.shells.length >= 3, `blind probe reported ${blind.shells.length} shells`);
    for (const fact of blind.shells) {
      assert(
        fact.probe.kind === "failure",
        `blind probe claimed success for ${fact.path}: ${JSON.stringify(fact.probe)}`,
      );
      assert(
        fact.version === null,
        `blind probe invented version ${fact.version} for ${fact.path}`,
      );
    }
    assert(
      !blind.remoteOperations.includes("shell"),
      "shell advertised although no shell probed successfully",
    );
    pass(
      "probe honesty",
      `no shell -> ${blind.shells
        .map((fact) => (fact.probe.kind === "failure" ? fact.probe.reason : "?"))
        .join("/")}`,
    );
  } else {
    skipWindowsOnly("probe honesty");
  }

  // ---------------------------------------------------------------- 2) session 区分
  assert(executionSessionKind(0) === "service_session_0", "Session 0 mapped to a desktop kind");
  assert(executionSessionKind(1) === "interactive_desktop", "Session 1 not mapped to desktop");
  assert(executionSessionKind(42) === "interactive_desktop", "Session 42 not mapped to desktop");
  pass("session mapping", "0->service_session_0, 1|42->interactive_desktop");
  if (isWindows) {
    const environment = capability.executionEnvironment;
    assert(environment, "executionEnvironment missing on Windows");
    assert(environment.sessionId !== null, `sessionId unreadable (${environment.sessionKind})`);
    const expected = environment.sessionId === 0 ? "service_session_0" : "interactive_desktop";
    assert(
      environment.sessionKind === expected,
      `session ${environment.sessionId} reported as ${environment.sessionKind}`,
    );
    if (expectSession !== null)
      assert(
        environment.sessionId === expectSession,
        `expected Session ${expectSession}, got ${environment.sessionId}`,
      );
    facts.session = { sessionId: environment.sessionId, sessionKind: environment.sessionKind };
    pass("execution environment", `session=${environment.sessionId}`);
    // 桌面会话不是 ssh 能造出来的：查一次真实登录会话，据实登记未验证项。
    // 控制台是 GBK，直接按 utf8 取会得到乱码，证据就不可核对了。
    const consoleText = (buffer: Buffer | undefined) => {
      const bytes = buffer ?? Buffer.alloc(0);
      try {
        return new TextDecoder("gbk").decode(bytes);
      } catch {
        return bytes.toString("utf8");
      }
    };
    const qwinsta = spawnSync("qwinsta", { encoding: "buffer" });
    const queryUser = spawnSync("query", ["user"], { encoding: "buffer" });
    const raw = `${consoleText(qwinsta.stdout)}${consoleText(qwinsta.stderr)}`.replace(/\r/g, "");
    const userOut = `${consoleText(queryUser.stdout)}${consoleText(queryUser.stderr)}`;
    const activeConsole = /(\bActive\b|活动)/.test(raw);
    const desktopPresent = activeConsole && !/No User exists/i.test(userOut);
    facts.qwinsta = raw
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .join(" | ");
    facts.queryUser = userOut.trim();
    unverify(
      "interactive_desktop 实机判定",
      desktopPresent
        ? "本机有活动桌面会话，但 ssh 执行落入 Session 0，无法在桌面会话内取数"
        : `本机无已登录桌面会话（query user: ${userOut.trim() || "no output"}），ssh 落入 Session 0`,
    );
  } else {
    skipWindowsOnly("execution environment / desktop session");
  }

  // ---------------------------------------------------------------- 3) 文件操作走跨平台 API
  const apiFile = join(work, "api-bytes.txt");
  const payloadText =
    'line1\r\nline2\n"quoted"\tback\\slash  $VAR %PATH% !bang & amp | pipe\n中文 😀\n';
  const writeCommand = command({
    kind: "file_write",
    path: apiFile,
    content: payloadText,
    mode: "overwrite",
  });
  apply([writeCommand]);
  const writeReport = await terminalOf(writeCommand.executionId, 20_000, "file_write");
  assert(writeReport.outcome === "succeeded", `file_write outcome ${writeReport.outcome}`);
  const writePayload = payloadOf(writeReport, "file_write");
  assert(
    writePayload.bytesWritten === Buffer.byteLength(payloadText),
    `file_write bytesWritten: ${JSON.stringify(writeReport.payload)}`,
  );
  assert(
    readFileSync(apiFile).equals(Buffer.from(payloadText, "utf8")),
    "file_write did not land byte-exact",
  );
  const readCommand = command({ kind: "file_read", path: apiFile, maxBytes: 262_144 });
  apply([readCommand]);
  const readReport = await terminalOf(readCommand.executionId, 20_000, "file_read");
  assert(readReport.outcome === "succeeded", `file_read outcome ${readReport.outcome}`);
  const readPayload = payloadOf(readReport, "file_read");
  assert(
    readPayload.content === payloadText && readPayload.truncated === false,
    `file_read round trip differs: ${JSON.stringify(readReport.payload).slice(0, 200)}`,
  );
  const appendCommand = command({
    kind: "file_write",
    path: apiFile,
    content: "\u0000tail",
    mode: "append",
  });
  apply([appendCommand]);
  await terminalOf(appendCommand.executionId, 20_000, "file_write append");
  assert(
    readFileSync(apiFile).equals(Buffer.from(`${payloadText}\u0000tail`, "utf8")),
    "append mode did not preserve bytes",
  );
  const limitCommand = command({ kind: "file_read", path: apiFile, maxBytes: 40 });
  apply([limitCommand]);
  const limitReport = await terminalOf(limitCommand.executionId, 20_000, "file_read limit");
  const limitPayload = payloadOf(limitReport, "file_read");
  assert(
    limitPayload.truncated === true && limitPayload.content?.length === 40,
    `maxBytes not honoured: ${JSON.stringify(limitReport.payload).slice(0, 120)}`,
  );
  // 反证：同样一句文本若走 shell 文本处理，落盘结果不是字节等价（echo 自带行尾）。
  const echoText = "sprout-p8d-api-bytes";
  const echoFile = join(work, "shell-bytes.txt");
  const echoShell = isWindows ? shells.get("cmd")! : live[0];
  const echoRun = await runShellOnTarget(echoShell, `echo ${echoText}> ${echoFile}`);
  assert(echoRun.report.outcome === "succeeded", `echo redirect: ${echoRun.report.outcome}`);
  const echoBytes = readFileSync(echoFile);
  assert(!echoBytes.equals(Buffer.from(echoText, "utf8")), "shell round trip was byte-equal?");
  pass(
    "file ops byte-exact",
    `api=${Buffer.byteLength(payloadText)}B exact, shell-echo=${JSON.stringify(echoBytes.toString("utf8"))}`,
  );

  // ---------------------------------------------------------------- 4) 真实链路里的 shell 往返
  const roundTrips: string[] = [];
  const roundTripShells = isWindows
    ? [shells.get("pwsh")!, shells.get("powershell")!, shells.get("cmd")!]
    : live;
  for (const shell of roundTripShells) {
    const marker = `sprout-p8d-${shell.kind}`;
    const run = await runShellOnTarget(shell, shellText(shell.kind, marker));
    assert(run.report.outcome === "succeeded", `${shell.kind} outcome ${run.report.outcome}`);
    const shellPayload = payloadOf(run.report, "shell");
    assert(
      shellPayload.exited === true && shellPayload.exitCode === 0,
      `${shell.kind} terminal payload: ${JSON.stringify(run.report.payload).slice(0, 200)}`,
    );
    assert(
      shellPayload.stdout?.includes(marker),
      `${shell.kind} stdout missing marker: ${JSON.stringify(run.report.payload).slice(0, 200)}`,
    );
    assert(
      existsSync(join(run.stateDirectory, "executions", run.executionId, "result.json")),
      `${shell.kind} left no durable result.json`,
    );
    roundTrips.push(`${shell.kind}=0`);
  }
  if (isWindows) {
    const failing = await runShellOnTarget(shells.get("cmd")!, "exit /b 7");
    // 非零退出是失败报告：观测到的退出码在 `partial` 里（成功形状的载荷），不在顶层。
    const failingPayload = payloadOf(failing.report, "shell");
    assert(failing.report.outcome === "failed", `cmd exit outcome ${failing.report.outcome}`);
    assert(
      failingPayload.failureReason === "executor_error" &&
        failingPayload.partial?.exited === true &&
        failingPayload.partial.exitCode === 7,
      `cmd exit code not preserved: ${JSON.stringify(failing.report.payload).slice(0, 200)}`,
    );
    pass("shell round trip", `${roundTrips.join(" ")} cmd-fail=7`);
  } else {
    pass("shell round trip (smoke)", roundTrips.join(" "));
  }

  // ---------------------------------------------------------------- 5) 进程枚举
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await until(() => sleeper.pid !== undefined && pidAliveSync(sleeper.pid), 5000, "sleeper alive");
  const sleeperPid = sleeper.pid!;
  strayPids.push(sleeperPid);
  const listCommand = command({ kind: "process_list", limit: 200 });
  apply([listCommand]);
  const listReport = await terminalOf(listCommand.executionId, 20_000, "process_list");
  assert(listReport.outcome === "succeeded", `process_list outcome ${listReport.outcome}`);
  // 契约把结果截到 200 行（limit 上限），所以只断言形状与自主枚举一致，不要求某个具体 pid 出现。
  const listPayload = payloadOf(listReport, "process_list");
  const items = listPayload.items ?? [];
  assert(items.length > 0, "process_list returned no rows");
  assert(items.length <= 200, `process_list returned ${items.length} rows for limit 200`);
  assert(
    items.every((item) => Number.isSafeInteger(item.pid) && item.pid > 0),
    "process_list returned a non-pid row",
  );
  assert(
    new Set(items.map((item) => item.pid)).size === items.length,
    "process_list returned duplicate pids",
  );
  assert(
    items.every((item) => item.command.trim().length > 0),
    "process_list returned empty command names",
  );
  facts.processList = {
    rows: items.length,
    truncated: listPayload.truncated === true,
    sample: items.slice(0, 3).map((item) => `${item.pid}:${item.command}`),
  };
  pass("process list", `${items.length} rows truncated=${String(listPayload.truncated)}`);

  // 单 pid 信号：用自己起的进程验「送达」与「真的消失」（列表被截断时这是更强的证据）。
  const killSleeper = command({ kind: "process_signal", pid: sleeperPid, signal: "TERM" });
  apply([killSleeper]);
  const killSleeperReport = await terminalOf(
    killSleeper.executionId,
    20_000,
    "process_signal single",
  );
  assert(
    killSleeperReport.outcome === "succeeded",
    `single signal outcome ${killSleeperReport.outcome}`,
  );
  assert(
    payloadOf(killSleeperReport, "process_signal").delivered === true,
    `single signal payload: ${JSON.stringify(killSleeperReport.payload)}`,
  );
  await until(() => !pidAliveSync(sleeperPid), 15_000, `pid ${sleeperPid} gone`);
  pass("process signal", `TERM pid ${sleeperPid} delivered and gone`);

  // ---------------------------------------------------------------- 6) 进程树终止
  const treeScript = join(work, "p8d-tree.mjs");
  const pidFile = join(work, "p8d-tree-pids.json");
  writeFileSync(
    treeScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const treeParent = spawn(process.execPath, [treeScript], { stdio: "ignore", windowsHide: true });
  assert(typeof treeParent.pid === "number", "tree parent did not start");
  const treeParentPid = treeParent.pid!;
  strayPids.push(treeParentPid);
  await until(() => existsSync(pidFile), 10_000, "tree pid file");
  const treePids = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; child: number };
  strayPids.push(treePids.child);
  const signalCommand = command({ kind: "process_signal", pid: treePids.parent, signal: "TERM" });
  apply([signalCommand]);
  const signalReport = await terminalOf(signalCommand.executionId, 20_000, "process_signal");
  assert(signalReport.outcome === "succeeded", `process_signal outcome ${signalReport.outcome}`);
  assert(
    payloadOf(signalReport, "process_signal").delivered === true,
    `process_signal payload: ${JSON.stringify(signalReport.payload)}`,
  );
  await until(() => !pidAliveSync(treePids.parent), 15_000, "signalled pid gone");
  assert(
    !JSON.stringify(signalReport).includes("term_delivered"),
    "a graceful termination leaked onto the wire",
  );
  if (isWindows) {
    assert(processTreeKillIsForced() === true, "win32 must report forced tree kill");
    await until(() => !pidAliveSync(treePids.child), 15_000, "tree child gone after /T /F");
    pass(
      "process tree kill",
      `forced=taskkill /T /F: parent ${treePids.parent} + child ${treePids.child} gone`,
    );
  } else {
    // POSIX 上 process_signal 只打单个 pid：树语义只有 Windows 能验，这里只验载荷。
    killPid(treePids.child);
    skipWindowsOnly("process tree kill (forced /T /F)");
  }
  facts.forcedTreeKill = processTreeKillIsForced();

  // ---------------------------------------------------------------- 7) 取消：Windows 只报 kill_delivered
  const cancelShell = primaryShell;
  const slowCommand = command({
    kind: "shell",
    command: sleepText(cancelShell.kind, 60),
    cwd: work,
    waitMs: 1000,
  });
  apply([slowCommand]);
  const slowChildPid = await childPidOf(slowCommand.executionId);
  strayPids.push(slowChildPid);
  const snapshot = await terminalOf(slowCommand.executionId, 20_000, "wait window snapshot");
  assert(
    payloadOf(snapshot, "shell").exited === false,
    `wait window should be a running snapshot: ${JSON.stringify(snapshot.payload).slice(0, 160)}`,
  );
  apply([], { cancellations: [cancellation(slowCommand.executionId)] });
  const cancelled = await terminalOf(
    slowCommand.executionId,
    60_000,
    "cancelled terminal",
    (report) => (report.payload as unknown as PayloadView).failureReason !== undefined,
  );
  assert(cancelled.outcome === "failed", `cancelled outcome ${cancelled.outcome}`);
  const cancelledPayload = payloadOf(cancelled, "shell");
  assert(
    cancelledPayload.failureReason === "cancelled",
    `cancelled payload: ${JSON.stringify(cancelled.payload).slice(0, 200)}`,
  );
  // 取消的终态可以早于退出观测（信号已下发、命令正在停）：两种形状都是合法的，
  // 但只要有 partial，就必须是「已退出」的事实，不能是猜的退出码。
  if (cancelledPayload.partial)
    assert(
      cancelledPayload.partial.exited === true,
      `cancelled partial is not an observed exit: ${JSON.stringify(cancelledPayload.partial)}`,
    );
  const cancelShape = cancelledPayload.partial ? "exited-with-partial" : "signal-only";
  assert(!JSON.stringify(cancelled).includes("term_delivered"), "graceful term reported on wire");
  const cancelStartedAt = Date.now();
  await until(() => !pidAliveSync(slowChildPid), 30_000, `cancelled pid ${slowChildPid} gone`);
  assert(!pidAliveSync(slowChildPid), `cancelled command ${slowChildPid} still alive`);
  facts.cancellation = {
    shape: cancelShape,
    killedAfterMs: Date.now() - cancelStartedAt,
    durableResult: existsSync(resultFile(slowCommand.executionId)),
    forced: processTreeKillIsForced(),
  };
  pass("cancellation", `failed/cancelled (${cancelShape}), pid ${slowChildPid} dead`);

  // ---------------------------------------------------------------- 8) 重连去重
  const tickFile = join(work, "p8d-dedup.txt");
  const tickCommand = command({
    kind: "shell",
    command: startText(cancelShell.kind, tickFile, 20),
    cwd: work,
    waitMs: 1000,
  });
  const tickFrameSeq = apply([tickCommand]);
  const tickExecution = tickCommand.executionId;
  await until(() => fileLines(tickFile).length === 1, 20_000, "first tick");
  // 8a) 原帧重发（同一 seq）：整帧是幂等确认，不重跑。
  const reportsBefore = JSON.stringify(reportsFor(tickExecution));
  replayLastFrame();
  assert(
    JSON.stringify(reportsFor(tickExecution)) === reportsBefore,
    "resending the original frame changed the report set",
  );
  await sleep(1500);
  assert(
    fileLines(tickFile).length === 1,
    `original-frame retry re-ran the command (${fileLines(tickFile).length})`,
  );
  assert(seq === tickFrameSeq, `replay moved the host sequence to ${seq}`);
  pass("reconnect dedup (same seq)", `frame ${tickFrameSeq} resent, ticks=1`);
  // 8b) 同一 executionId 换 seq 重投：内容不同即僵化代次，不得静默重跑。
  let rejected = "";
  try {
    apply([tickCommand]);
  } catch (error) {
    rejected = error instanceof Error ? error.message : String(error);
  }
  assert(
    rejected === "stale_generation",
    `re-dispatch was not refused: ${JSON.stringify(rejected)}`,
  );
  await sleep(1500);
  assert(
    fileLines(tickFile).length === 1,
    `re-dispatch re-ran the command (${fileLines(tickFile).length})`,
  );
  pass("reconnect dedup (new seq)", "same executionId refused with stale_generation, ticks=1");

  // ---------------------------------------------------------------- 9) 未观测退出 + 重启不重跑
  const lostFile = join(work, "p8d-lost.txt");
  const lostCommand = command({
    kind: "shell",
    command: startText(cancelShell.kind, lostFile, 60),
    cwd: work,
    waitMs: 1000,
  });
  apply([lostCommand]);
  const lostExecution = lostCommand.executionId;
  const lostChildPid = await childPidOf(lostExecution);
  strayPids.push(lostChildPid);
  await until(() => fileLines(lostFile).length === 1, 20_000, "lost tick");
  const runnerPid = readJson(runnerFile(lostExecution)).pid as number;
  assert(typeof runnerPid === "number" && runnerPid > 1, "runner pid missing");
  const killRunner = spawnSync(
    isWindows ? "taskkill" : "kill",
    isWindows ? ["/PID", String(runnerPid), "/F"] : ["-9", String(runnerPid)],
    { encoding: "utf8" },
  );
  const lostTerminal = await terminalOf(lostExecution, 60_000, "unobserved exit");
  const commandAlive = pidAliveSync(lostChildPid);
  assert(
    lostTerminal.outcome === "unknown",
    `runner killed but outcome was ${lostTerminal.outcome}`,
  );
  const lostPayload = payloadOf(lostTerminal, "shell");
  assert(
    lostPayload.failureReason === "worker_lost",
    `unobserved payload: ${JSON.stringify(lostTerminal.payload).slice(0, 200)}`,
  );
  assert(
    lostTerminal.recoveryReason === "child-exited-without-result",
    `recoveryReason: ${String(lostTerminal.recoveryReason)}`,
  );
  assert(!existsSync(resultFile(lostExecution)), "no result.json may exist for an unobserved exit");
  assert(fileLines(lostFile).length === 1, "command was re-run before recovery");
  pass(
    "unobserved exit",
    `kill=${killRunner.status} recoveryReason=child-exited-without-result commandAliveAfterRunnerKill=${commandAlive}`,
  );
  facts.commandAliveAfterRunnerKill = commandAlive;
  if (commandAlive) killPid(lostChildPid);

  // 重启：同一 state dir、新会话。已跑过的执行必须不重跑，恢复事实只能报未知退出。
  const session2: WorkerSession = {
    machineId,
    generation: 2,
    bootId: newId(ID_PREFIXES.boot),
    attemptId: randomUUID(),
  };
  const dispatcher2 = new RemoteDispatcher(
    session2,
    capability,
    Date.now,
    undefined as never,
    new ExecutionRegistry(new ExecutionStore(stateDirectory), Date.now),
  );
  const restored = dispatcher2.registry.runs.get(lostExecution);
  assert(restored, "restart did not restore the lost execution from disk");
  assert(restored.started === true, "restored execution does not remember that it ran");
  assert(restored.done === false, "lost execution was written as a known terminal state");
  const runnerStamp = readJson(runnerFile(lostExecution)).pid;
  let seq2 = 1;
  dispatcher2.accept(
    {
      mode: "normal",
      session: session2,
      seq: 1,
      configuration: { root: null, rootRevision: 1, bindings: [] },
      remote: wire([{ ...lostCommand, dispatchSession: session2, dispatchSeq: 1 }]),
    },
    1,
    [],
  );
  await sleep(2000);
  assert(
    fileLines(lostFile).length === 1,
    `restarted worker re-ran the command (${fileLines(lostFile).length})`,
  );
  assert(
    readJson(runnerFile(lostExecution)).pid === runnerStamp,
    "restarted worker spawned a second runner",
  );
  // 恢复事实每批最多 8 条：用空帧把已送达的那批标记掉，才有位置看到排在后面的执行。
  let recoveryFact: NonNullable<RemoteWireOutput["recoveries"]>[number] | undefined;
  let recoveryBatches = 0;
  for (let round = 0; round < 6 && !recoveryFact; round += 1) {
    const batch = dispatcher2.outgoing(1048576).recoveries ?? [];
    recoveryFact = batch.find((item) => item.executionId === lostExecution);
    if (recoveryFact) break;
    if (batch.length === 0) break;
    recoveryBatches += 1;
    seq2 += 1;
    dispatcher2.accept(
      {
        mode: "normal",
        session: session2,
        seq: seq2,
        configuration: { root: null, rootRevision: 1, bindings: [] },
        remote: wire([]),
      },
      seq2,
      [],
    );
  }
  const fact = recoveryFact;
  assert(
    fact,
    `no recovery fact for ${lostExecution} after ${String(recoveryBatches)} extra batches`,
  );
  assert(
    fact.observedState === "unknown" && fact.observedReason === "child-exited-without-result",
    `recovery fact: ${JSON.stringify(fact).slice(0, 240)}`,
  );
  assert(fact.exitCode === null && fact.signal === null, "recovery fact invented an exit code");
  pass(
    "restart recovery",
    `restored started=true done=false, re-dispatch did not re-run, ${fact.observedState}:${fact.observedReason}`,
  );

  console.log(
    `${SMOKE ? "P8D_INTEGRATION_SMOKE_OK" : "P8D_WINDOWS_INTEGRATION_OK"} ${JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      primaryShell: primaryShell.kind,
      shells: capability.shells.map((fact) => `${fact.kind}:${fact.probe.kind}:${fact.version}`),
      passed,
      unverified,
      facts,
    })}`,
  );
} finally {
  clearTimeout(watchdog);
  for (const pid of strayPids) killPid(pid);
  await sleep(isWindows ? 1000 : 300);
  try {
    // Windows 上被杀进程可能还占着目录（shell 的 cwd 就是 work），重试几次再判定。
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    console.error(`cleanup left ${work}: ${String(error)}`);
  }
}
