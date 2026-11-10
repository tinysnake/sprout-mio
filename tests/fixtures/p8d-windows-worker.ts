/**
 * P8d 真实 Windows Worker 验收：在 Windows 机器上跑真实探测、真实 runner 与真实进程树终止。
 *
 * 这里验证的是「平台适配 + 执行与恢复的可观测事实」，不是完整 Worker↔服务端链路；
 * 协议与重连去重由本机单测覆盖。缺 Windows 时由 p8d-windows-worker.sh 明确报错，不静默跳过。
 *
 * 用法：node p8d-windows-worker.mjs <runner.js> [expectSessionId]
 * 产物：stdout 的 PASS 行与最后一行 `P8D_WINDOWS_E2E_OK {json}`；失败抛错并以非零码退出。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellFact } from "../../src/contracts/machine";
import { projectWorkingPath } from "../../src/contracts/machine";
import type { WorkerSession } from "../../src/contracts/worker-session";
import { killProcessTree, parseTasklistCsv, spawnProcessList } from "../../src/worker/platform";
import { probeCapability, probeDirectory } from "../../src/worker/probes";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
let passed = 0;
function pass(name: string, detail = "") {
  passed++;
  console.log(`PASS ${name}${detail ? ` ${detail}` : ""}`);
}
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
async function nodePids(): Promise<Set<number>> {
  const child = spawnProcessList();
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tasklist exit ${code}`)),
    );
  });
  return new Set(parseTasklistCsv(Buffer.concat(chunks).toString("utf8")).map((item) => item.pid));
}

const runnerPath = process.argv[2];
assert(runnerPath && existsSync(runnerPath), `runner bundle missing: ${runnerPath}`);
const expectSession = process.argv[3] ? Number(process.argv[3]) : null;
const work = mkdtempSync(join(tmpdir(), "sprout-p8d-"));
const session: WorkerSession = {
  machineId: "mch_00000000-0000-4000-8000-000000000000",
  generation: 1,
  bootId: "boot_00000000-0000-4000-8000-000000000000",
  attemptId: "00000000-0000-4000-8000-000000000000",
};

/** 真实 runner：命令正文走环境变量，退出事实只认 result.json。 */
async function runCommand(shell: ShellFact, text: string) {
  const executionId = `exe_${crypto.randomUUID()}`;
  const stateDirectory = join(work, `state-${executionId}`);
  mkdirSync(stateDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [runnerPath, executionId, "token", stateDirectory, shell.path, shell.kind],
    {
      env: { ...process.env, SPROUT_RUNNER_COMMAND: text },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const directory = join(stateDirectory, "executions", executionId);
  return {
    executionId,
    directory,
    stateDirectory,
    stdout,
    stderr,
    runnerExitCode: exitCode,
    claim: readJson(join(directory, "runner.json")),
    result: existsSync(join(directory, "result.json"))
      ? readJson(join(directory, "result.json"))
      : null,
  };
}

try {
  assert(process.platform === "win32", `not Windows: ${process.platform}`);
  pass("platform", `${process.platform} ${process.arch} node ${process.version}`);

  // 1) 能力探测：三种 shell 必须按实际可执行文件区分，不能只报一个 powershell。
  const capability = await probeCapability(now());
  assert(capability.platform === "win32", `capability platform ${capability.platform}`);
  const shells = new Map(capability.shells.map((fact) => [fact.kind, fact]));
  for (const kind of ["pwsh", "powershell", "cmd"] as const) {
    const fact = shells.get(kind);
    assert(fact, `capability does not report ${kind}`);
    assert(fact.probe.kind === "success", `${kind} probe failed: ${JSON.stringify(fact.probe)}`);
    assert(fact.path.includes("\\"), `${kind} path is not a Windows path: ${fact.path}`);
    assert(fact.version, `${kind} reports no version`);
  }
  const major = (fact: ShellFact) => Number.parseInt(fact.version?.split(".")[0] ?? "", 10);
  assert(
    major(shells.get("pwsh")!) >= 7,
    `pwsh is not PowerShell 7: ${shells.get("pwsh")!.version}`,
  );
  assert(
    major(shells.get("powershell")!) === 5,
    `Windows PowerShell major is not 5: ${shells.get("powershell")!.version}`,
  );
  assert(capability.remoteOperations.includes("shell"), "shell operation not advertised");
  pass(
    "capability shells",
    ["pwsh", "powershell", "cmd"]
      .map((kind) => `${kind}=${shells.get(kind as ShellFact["kind"])!.version}`)
      .join(" "),
  );

  // 2) 执行环境：Session 0 与桌面必须落在不同取值，且与 SessionId 自洽。
  const environment = capability.executionEnvironment;
  assert(environment, "executionEnvironment missing");
  assert(
    environment.sessionId !== null,
    `executionEnvironment has no SessionId (${environment.sessionKind})`,
  );
  const expectedKind = environment.sessionId === 0 ? "service_session_0" : "interactive_desktop";
  assert(
    environment.sessionKind === expectedKind,
    `session ${environment.sessionId} reported as ${environment.sessionKind}, expected ${expectedKind}`,
  );
  if (expectSession !== null)
    assert(
      environment.sessionId === expectSession,
      `expected Session ${expectSession}, got ${environment.sessionId}`,
    );
  pass("execution environment", `session=${environment.sessionId} kind=${environment.sessionKind}`);

  // 3) 目录：Windows 绝对路径按原生分隔符派生，探测结果带真实 realPath。
  const projectId = "prj_00000000-0000-4000-8000-000000000000";
  const root = join(work, "root");
  mkdirSync(join(root, projectId), { recursive: true });
  assert(
    projectWorkingPath(root, projectId) === join(root, projectId),
    `projectWorkingPath ${projectWorkingPath(root, projectId)} != ${join(root, projectId)}`,
  );
  const observation = await probeDirectory(root, projectId, 1, 1, session, 1, now());
  assert(
    observation.result.kind === "accessible",
    `directory probe: ${JSON.stringify(observation.result)}`,
  );
  pass("directory", observation.result.realPath);

  // 4) 真实 runner：三种 shell 各自执行成功并回传退出码。
  const okShells: ShellFact[] = [
    shells.get("pwsh")!,
    shells.get("powershell")!,
    shells.get("cmd")!,
  ];
  for (const shell of okShells) {
    const text = shell.kind === "cmd" ? "echo sprout-p8d-ok" : "Write-Output sprout-p8d-ok";
    const run = await runCommand(shell, text);
    assert(run.result, `${shell.kind} produced no result.json (runner exit ${run.runnerExitCode})`);
    assert(run.result.exitCode === 0, `${shell.kind} exit ${String(run.result.exitCode)}`);
    assert(
      run.stdout.includes("sprout-p8d-ok"),
      `${shell.kind} stdout missing marker: ${JSON.stringify(run.stdout)} ${JSON.stringify(run.stderr)}`,
    );
    pass(`runner ${shell.kind}`, `exit=0 claimPid=${String(run.claim.pid)}`);
  }
  const failing = await runCommand(shells.get("cmd")!, "exit /b 7");
  assert(
    failing.result?.exitCode === 7,
    `cmd exit code not preserved: ${JSON.stringify(failing.result)}`,
  );
  pass("runner exit code", "cmd exit /b 7 -> 7");

  // 5) 进程树终止：taskkill /T /F 打命令组，runner 活着把退出事实落盘。
  const treeScript = join(work, "tree.mjs");
  const pidFile = join(work, "tree-pids.txt");
  writeFileSync(
    treeScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "writeFileSync(process.argv[2], `${process.pid}\\n${child.pid}\\n`);",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  const tree = await startBackground(shells.get("pwsh")!, `node "${treeScript}" "${pidFile}"`);
  await until(
    () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().split("\n").length === 2,
    15000,
    "process tree pids",
  );
  const [treePid, grandchildPid] = readFileSync(pidFile, "utf8")
    .trim()
    .split("\n")
    .map((value) => Number(value));
  const groupPid = Number(tree.claim.childPid);
  assert(
    Number.isSafeInteger(groupPid) && groupPid > 0,
    `claim has no childPid: ${String(tree.claim.childPid)}`,
  );
  assert(killProcessTree(groupPid), "killProcessTree returned false");
  await until(
    async () => {
      const pids = await nodePids();
      return !pids.has(treePid) && !pids.has(grandchildPid) && !pids.has(groupPid);
    },
    15000,
    "process tree exit",
  );
  await until(
    () => existsSync(join(tree.directory, "result.json")),
    15000,
    "result after tree kill",
  );
  const treeResult = readJson(join(tree.directory, "result.json"));
  assert(treeResult.exitCode !== 0, `tree kill reported success: ${JSON.stringify(treeResult)}`);
  pass(
    "process tree kill",
    `group=${groupPid} tree=${treePid} grandchild=${grandchildPid} exit=${String(treeResult.exitCode)}`,
  );

  // 6) runner 被杀：命令仍活着，磁盘上没有 result —— 恢复事实是「未观测」，不是重跑。
  const lost = await startBackground(shells.get("pwsh")!, "Start-Sleep -Seconds 60");
  const runnerPid = Number(lost.claim.pid);
  const commandPid = Number(lost.claim.childPid);
  assert(Number.isSafeInteger(runnerPid) && runnerPid > 0, "claim has no runner pid");
  const killed = spawnSync(
    process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "taskkill.exe") : "taskkill",
    ["/PID", String(runnerPid), "/F"],
    { stdio: "ignore", windowsHide: true },
  );
  assert(killed.status === 0, `taskkill runner failed: ${String(killed.status)}`);
  await until(() => !existsSync(join(lost.directory, "result.json")), 5000, "missing result");
  assert(!existsSync(join(lost.directory, "result.json")), "result appeared after runner kill");
  assert(existsSync(join(lost.directory, "runner.json")), "durable claim disappeared");
  const reread = readJson(join(lost.directory, "runner.json"));
  assert(reread.childPid === commandPid, "claim changed after runner kill");
  // Windows 的控制台语义：runner 一死，命令随控制台一起结束；但磁盘上不许出现结果。
  // 恢复只能把这次执行当成「未观测」，自动重启不得重跑（dispatcher 侧由单测守住）。
  const commandStillRunning = (await nodePids()).has(commandPid);
  if (commandStillRunning)
    assert(killProcessTree(commandPid), "cleanup killProcessTree returned false");
  pass(
    "unobserved exit",
    `runner=${runnerPid} command=${commandPid} result=absent commandAliveAfterRunnerKill=${commandStillRunning}`,
  );

  console.log(
    `P8D_WINDOWS_E2E_OK ${JSON.stringify({
      passed,
      platform: capability.platform,
      arch: capability.arch,
      sessionId: environment.sessionId,
      sessionKind: environment.sessionKind,
      shells: okShells.map((shell) => ({
        kind: shell.kind,
        path: shell.path,
        version: shell.version,
      })),
    })}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** 起一个后台命令（不等退出），返回 claim 与目录。 */
async function startBackground(shell: ShellFact, text: string) {
  const executionId = `exe_${crypto.randomUUID()}`;
  const stateDirectory = join(work, `state-${executionId}`);
  mkdirSync(stateDirectory, { recursive: true });
  const child = spawn(
    process.execPath,
    [runnerPath, executionId, "token", stateDirectory, shell.path, shell.kind],
    {
      env: { ...process.env, SPROUT_RUNNER_COMMAND: text },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  const directory = join(stateDirectory, "executions", executionId);
  await until(() => existsSync(join(directory, "runner.json")), 15000, "runner claim");
  const claim = readJson(join(directory, "runner.json"));
  await until(() => Number(claim.childPid) > 0, 15000, "command pid");
  const refreshed = readJson(join(directory, "runner.json"));
  const merged: Record<string, unknown> = { ...claim };
  merged.childPid = refreshed.childPid;
  return { executionId, directory, claim: merged };
}
