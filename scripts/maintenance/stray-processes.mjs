#!/usr/bin/env node
// 宿主机残留进程检查。进程的父进程退出后 ppid 变成 1，它就不再属于任何一次运行，却还占着端口、
// 跑着计时器、写着自己的 worktree。verify runner 只能收掉它自己 spawn 的后代（见 scripts/verify/lib/
// sandbox.mjs），跨运行存活的、detach 出去的那些得由这一层兜住。
//
// 判定条件（全部满足才算残留）：
//   1. ppid === 1：启动它的会话已经退出；
//   2. 命令行、环境或工作目录指向本仓库的某个 checkout / worktree；
//   3. 命令行是本项目的运行进程（dev server、verify/harness 脚本、build 产物、迁移），
//      或者它的环境属于一次已经结束的 verify 运行；
//   4. 不属于一次仍在运行的 verify：SPROUT_VERIFY_RUN_DIR 下 context.json 的 ownerPid 还活着；
//   5. 不是并发 verify 沙箱里正常工作的进程（沙箱私有树 + 它自己那次运行还活着）；
//   6. 存活时间达到 --min-age（默认 1 小时）：刚起的后台命令跟残留长得一模一样（项目约定就鼓励用
//      nohup 跑长命令），所以只把活过头一段时间的算失败；活着的 verify 运行属主及其祖先直接跳过。
//
// 反面清单同样重要：部署实例（环境里带 SPROUT_RUNTIME_ROOT 的 prod/drill）不归本检查管，agent / MCP /
// 编辑器宿主进程一律不碰。所以这里只认本仓库的运行入口，而不是「凡是跟本仓库有关的进程」。
//
// 退出码：0 干净；1 发现残留（或 --fix 后仍有活着）；2 探针不可用（无法读进程表/环境，宁可失败也不假装干净）。

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sandboxMarker = "/.verify/sandboxes/";
const skipEnvironmentVariable = "SPROUT_STRAY_SKIP";
const terminateGraceMs = 10_000;
const forceGraceMs = 3_000;
const commandWidth = 160;
const defaultMinimumStrayAgeSeconds = 3_600;

// 不该被当成本项目运行进程的宿主：agent、MCP server、编辑器。误杀它们会打断人的工作。
const foreignHostPattern =
  /\bmcp\b|mcp[-_]|cua-driver|vestigio|magpie|obelisk|openpencil|pi-stuff|pi-extensions|\/\.pi\/|t3-code|herdr|kitty|kitten|vim |nvim|emacs|Code Helper/i;

// 「本项目的运行进程」正面清单：只看这些入口，避免把别人的 node 进程算成残留。
const runtimePatterns = [
  /node_modules\/(?:\.bin\/)?(?:vite|vite-plus|vitest|playwright|playwright-core|tsx|drizzle-kit)\b/,
  /node_modules\/@playwright\b/,
  /\.output\/server\/index\.mjs\b/,
  /dist\/worker\/main\.js\b/,
  /scripts\/(?:verify|verify-live|dev|browser|diagnostics|human-review|maintenance)\//,
  /scripts\/pi-host-runner\.mjs\b/,
  /scripts\/verify\.sh\b/,
  /src\/db\/migrate\.ts\b/,
];

// 部署实例的运行形态：<runtime root>/<实例>/app/.output/... 与 <runtime root>/<实例>/worker/app/dist/...
const deployLayoutPattern =
  /\/[^/\s]+\/app\/\.output\/server\/index\.mjs\b|\/[^/\s]+\/worker\/app\/dist\/worker\/main\.js\b/;
const deployEnvironmentPattern = /(?:^|\s)SPROUT_RUNTIME_ROOT=/;
const inspectablePattern = /\b(?:node|bun|deno|tsx|python3?)\b|\.(?:mjs|cjs|js|ts)\b/;

export function isForeignHost(command) {
  return foreignHostPattern.test(command);
}

export function isProjectRuntime(command) {
  return runtimePatterns.some((pattern) => pattern.test(command));
}

export function looksLikeRuntimeProcess(command) {
  return inspectablePattern.test(command);
}

// ps 的 etime：SS、MM:SS、HH:MM:SS、DD-HH:MM:SS。
export function parseElapsed(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds);
  return Number.isSafeInteger(total) ? total : null;
}

export function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: Number(match[4]),
      state: match[5],
      elapsed: parseElapsed(match[6]),
      command: match[7].trim(),
    });
  }
  return rows;
}

export function classifyKind(command) {
  if (/node_modules\/(?:\.bin\/)?(?:vite|vite-plus)\b/.test(command)) return "dev-server";
  if (/\.output\/server\/index\.mjs\b/.test(command)) return "app-server";
  if (/dist\/worker\/main\.js\b/.test(command)) return "worker";
  if (/scripts\/verify\//.test(command)) return "verify";
  if (/scripts\/pi-host-runner\.mjs\b|scripts\/verify\.sh\b/.test(command)) return "harness";
  if (/scripts\/(?:dev|browser|diagnostics|human-review|maintenance)\//.test(command))
    return "harness";
  if (
    /node_modules\/(?:\.bin\/)?(?:playwright|playwright-core)\b|node_modules\/@playwright\b/.test(
      command,
    )
  )
    return "browser";
  if (/src\/db\/migrate\.ts\b|drizzle-kit/.test(command)) return "database";
  return "process";
}

export function detectPort(command) {
  const match = /(?:^|\s)--port[= ](\d+)/.exec(command);
  return match === null ? null : Number(match[1]);
}

export function processAlive(
  pid,
  { kill = (target, signal) => process.kill(target, signal) } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function readRunContext(directory, { read = (file) => readFileSync(file, "utf8") } = {}) {
  try {
    const parsed = JSON.parse(read(join(directory, "context.json")));
    if (parsed === null || typeof parsed !== "object") return null;
    return {
      ownerPid: Number.isInteger(parsed.ownerPid) ? parsed.ownerPid : null,
      root: typeof parsed.root === "string" ? parsed.root : null,
    };
  } catch {
    return null;
  }
}

// 一次 verify 运行的三个状态：live（runner 还活着）、stale（runner 已退出）、none（不属于任何一次运行）。
export function verifyRunState(
  text,
  { readContext = readRunContext, isAlive = processAlive } = {},
) {
  const match = /SPROUT_VERIFY_RUN_DIR=([^\s"']+)/.exec(String(text));
  if (match === null) return { state: "none", directory: null, root: null };
  const context = readContext(match[1]);
  const state =
    context !== null && context.ownerPid !== null && isAlive(context.ownerPid) ? "live" : "stale";
  return { state, directory: match[1], root: context?.root ?? null };
}

function readRunDirectories(
  directory,
  { read = (target) => readdirSync(target, { withFileTypes: true }) } = {},
) {
  try {
    return read(directory)
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

// 还活着的 verify run 的属主：每个 checkout 的 .verify/runs/<id>/context.json 里写着 runner 自己的 pid。
// runner 常是被 nohup 起来的长命令，它自己的 ppid 就是 1，只看进程表跟残留没法区分。
export function liveRunOwners(
  roots,
  { list = readRunDirectories, readContext = readRunContext, isAlive = processAlive } = {},
) {
  const owners = new Set();
  for (const root of roots) {
    for (const directory of list(join(root, ".verify", "runs"))) {
      const ownerPid = readContext(directory)?.ownerPid ?? null;
      if (ownerPid !== null && isAlive(ownerPid)) owners.add(ownerPid);
    }
  }
  return owners;
}

// 活着的 verify run 属主及其存活祖先一并保护：`nohup bash -c '... bash scripts/verify.sh' &` 这样的
// 包装 shell 在 ppid 变成 1 之后与残留长得一样，但它下面的运行还在干活。
export function protectedProcesses(rows, ownerPids) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const protectedPids = new Set();
  for (const ownerPid of ownerPids) {
    let current = ownerPid;
    while (
      Number.isInteger(current) &&
      current > 1 &&
      byPid.has(current) &&
      !protectedPids.has(current)
    ) {
      protectedPids.add(current);
      current = byPid.get(current).ppid;
    }
  }
  return protectedPids;
}

export function formatElapsed(seconds) {
  if (seconds === null) return "未知";
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

function mentionsRoot(text, roots) {
  return roots.some((root) => text.includes(root));
}

function mentionsRootInDirectory(directory, roots) {
  // macOS 的 lsof 报 /private/... 而配置里常写 /tmp 这类符号链接形态，两边都试一次。
  const candidates = [directory, directory.replace(/^\/private/, ""), `/private${directory}`];
  return candidates.some((candidate) => mentionsRoot(candidate, roots));
}

// 纯函数：把进程表与收集到的事实（env、cwd）判成 related（本仓库相关）与 strays（残留）。
export function selectStrays({
  rows,
  roots,
  facts = new Map(),
  runs = new Map(),
  currentPid = process.pid,
  minimumAgeSeconds = defaultMinimumStrayAgeSeconds,
  protectedPids = new Set(),
}) {
  const related = [];
  const strays = [];
  for (const row of rows) {
    if (row.pid === currentPid) continue;
    if (row.ppid !== 1) continue;
    if (row.state.startsWith("Z")) continue;
    if (row.pgid <= 0) continue;
    if (protectedPids.has(row.pid)) continue;
    if (isForeignHost(row.command)) continue;
    if (deployLayoutPattern.test(row.command)) continue;
    const fact = facts.get(row.pid) ?? {};
    const environment = typeof fact.environment === "string" ? fact.environment : "";
    if (deployEnvironmentPattern.test(environment)) continue;
    const run = runs.get(row.pid) ?? { state: "none", directory: null, root: null };
    const cwd = typeof fact.cwd === "string" ? fact.cwd : null;
    const inRepository =
      mentionsRoot(row.command, roots) ||
      mentionsRoot(environment, roots) ||
      (run.root !== null && mentionsRoot(run.root, roots)) ||
      (cwd !== null && mentionsRootInDirectory(cwd, roots));
    if (!inRepository) continue;
    if (!isProjectRuntime(row.command) && run.state === "none") continue;
    const entry = {
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      command: row.command,
      kind: classifyKind(row.command),
      port: detectPort(row.command),
      elapsedSeconds: row.elapsed,
      runState: run.state,
      runDirectory: run.directory,
    };
    related.push(entry);
    if (run.state === "live") continue;
    const sandboxed = `${row.command}\n${environment}`.includes(sandboxMarker);
    if (sandboxed && run.state === "none") continue;
    strays.push(entry);
  }
  const failing = strays.filter(
    (entry) => entry.elapsedSeconds === null || entry.elapsedSeconds >= minimumAgeSeconds,
  );
  return { related, strays, failing };
}

export function findRepositoryRoots(
  root = checkout,
  { runGit = defaultRunGit, exists = existsSync } = {},
) {
  const roots = new Set([root]);
  const top = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (top !== null) roots.add(resolve(top));
  const listed = runGit(root, ["worktree", "list", "--porcelain"]);
  if (listed !== null) {
    for (const line of listed.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      roots.add(resolve(line.slice("worktree ".length).trim()));
    }
  }
  const sibling = join(homedir(), ".t3", "worktrees", "sprout-mio");
  if (exists(sibling)) roots.add(sibling);
  const paths = [];
  for (const candidate of roots) {
    if (candidate.length <= 8) continue;
    paths.push(candidate);
    try {
      const real = realpathSync(candidate);
      if (real !== candidate) paths.push(real);
    } catch {
      // 路径可能已经被清掉，保留字面值即可。
    }
  }
  return [...new Set(paths)];
}

function defaultRunGit(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

export function readProcessTable({ run = spawnSync } = {}) {
  const result = run("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10_000,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  return parseProcessTable(result.stdout);
}

// 一次 ps 调用取回这些进程的环境（`ps eww`）。macOS 对部分进程不给环境，这时返回的 blob 里
// 就没有 KEY= 形态的内容，判定按「没有证据」处理，不会因此误判成残留。
export function readEnvironments(pids, { run = spawnSync } = {}) {
  const environments = new Map();
  if (pids.length === 0) return environments;
  const result = run("ps", ["eww", "-o", "pid=,command=", "-p", pids.join(",")], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10_000,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (match === null) continue;
    environments.set(Number(match[1]), match[2]);
  }
  return environments;
}

export function readWorkingDirectories(pids, { run = spawnSync } = {}) {
  const directories = new Map();
  for (const pid of pids) {
    const result = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string")
      continue;
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("n"));
    if (line === undefined) continue;
    directories.set(pid, line.slice(1));
  }
  return directories;
}

// ownPgid 是检查进程自己所在进程组的 id。残留进程恰好与本检查同组时（同一次 shell 调用里留下的），
// 只能按 pid 收，发进程组信号会把检查自己带走。ownPgid 未知时同样保守，只按 pid 收。
function signalStray(stray, signal, { ownPgid = null } = {}) {
  const targets = new Set([stray.pid]);
  if (ownPgid !== null && stray.pgid !== ownPgid) targets.add(-stray.pgid);
  const failures = [];
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch (error) {
      if (error?.code === "ESRCH" || error?.code === "EPERM") continue;
      failures.push(`${target}: ${error?.message ?? error}`);
    }
  }
  return failures;
}

function aliveStrays(strays, { run = spawnSync, ownPgid = null } = {}) {
  const rows = readProcessTable({ run });
  if (rows === null) return strays.filter((stray) => processAlive(stray.pid));
  const live = new Set();
  for (const row of rows) {
    if (row.state.startsWith("Z")) continue;
    live.add(row.pid);
    live.add(`pgid:${row.pgid}`);
  }
  return strays.filter((stray) => {
    if (live.has(stray.pid)) return true;
    if (ownPgid !== null && stray.pgid === ownPgid) return false;
    return live.has(`pgid:${stray.pgid}`);
  });
}

async function waitForExit(
  strays,
  budgetMs,
  { delay = sleep, alive = aliveStrays, ownPgid = null } = {},
) {
  const deadline = Date.now() + budgetMs;
  let remaining = strays;
  while (remaining.length > 0) {
    remaining = alive(remaining, { ownPgid });
    if (remaining.length === 0 || Date.now() >= deadline) return remaining;
    await delay(200);
  }
  return remaining;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export async function stopStrays(
  strays,
  { delay = sleep, alive = aliveStrays, ownPgid = null } = {},
) {
  const failures = [];
  for (const stray of strays) failures.push(...signalStray(stray, "SIGTERM", { ownPgid }));
  const survivors = await waitForExit(strays, terminateGraceMs, { delay, alive, ownPgid });
  for (const stray of survivors) failures.push(...signalStray(stray, "SIGKILL", { ownPgid }));
  const stubborn = await waitForExit(survivors, forceGraceMs, { delay, alive, ownPgid });
  return { survivors: stubborn, failures };
}

function parseArguments(argv) {
  const options = {
    fix: false,
    json: false,
    minimumAgeSeconds: defaultMinimumStrayAgeSeconds,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fix") options.fix = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--min-age" || argument.startsWith("--min-age=")) {
      const raw =
        argument === "--min-age" ? argv[(index += 1)] : argument.slice("--min-age=".length);
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`--min-age 需要非负秒数，收到 ${raw}`);
      }
      options.minimumAgeSeconds = seconds;
    } else {
      throw new Error(`未知参数 ${argument}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`用法：node scripts/maintenance/stray-processes.mjs [选项]

检查宿主上是否留着本仓库的残留进程（父进程已退出的 dev server、verify/harness 脚本等）。

选项：
  --json          输出机器可读的结果
  --fix           先 SIGTERM、10 秒后再 SIGKILL 地收掉判为失败的残留（要连未满 --min-age 的一起收，
                  用 --min-age 0 --fix）
  --min-age <秒>  只把存活时间达到该秒数的进程判为失败（默认 3600）
  --help          显示这段帮助

环境变量：
  ${skipEnvironmentVariable}=1   跳过检查（供确实需要跳过时使用，输出 SKIP）

退出码：0 干净；1 发现残留（或 --fix 后仍有活着）；2 探针不可用。`);
}

function describe(entry) {
  const port = entry.port === null ? "" : ` 端口 ${entry.port}`;
  const run = entry.runState === "stale" ? "，所属 verify 运行已结束" : "";
  return `  pid ${entry.pid}  ${entry.kind}  存活 ${formatElapsed(entry.elapsedSeconds)}${port}  pgid ${entry.pgid}${run}\n    ${entry.command.slice(0, commandWidth)}`;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    printUsage();
    return 0;
  }
  const skipped = process.env[skipEnvironmentVariable] === "1";
  if (skipped) {
    if (options.json) console.log(JSON.stringify({ skipped: true }, null, 2));
    else console.log(`SKIP stray-processes: ${skipEnvironmentVariable}=1`);
    return 0;
  }
  const roots = findRepositoryRoots();
  const table = readProcessTable();
  if (table === null) {
    console.error("FAIL stray-processes: 读不到进程表（ps 不可用），无法判定");
    return 2;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const candidates = table.filter(
    (row) =>
      (uid === null || row.uid === uid) &&
      row.ppid === 1 &&
      !row.state.startsWith("Z") &&
      !isForeignHost(row.command) &&
      (isProjectRuntime(row.command) || looksLikeRuntimeProcess(row.command)),
  );
  const environments = readEnvironments(candidates.map((row) => row.pid));
  if (environments === null) {
    console.error("FAIL stray-processes: 读不到进程环境（ps eww 不可用），无法判定");
    return 2;
  }
  const directories = readWorkingDirectories(
    candidates.filter((row) => !environments.has(row.pid)).map((row) => row.pid),
  );
  const facts = new Map(
    candidates.map((row) => [
      row.pid,
      { environment: environments.get(row.pid) ?? "", cwd: directories.get(row.pid) ?? null },
    ]),
  );
  const runs = new Map([...facts].map(([pid, fact]) => [pid, verifyRunState(fact.environment)]));
  const ownPgid = table.find((row) => row.pid === process.pid)?.pgid ?? null;
  const protectedPids = protectedProcesses(table, liveRunOwners(roots));
  const { related, strays, failing } = selectStrays({
    rows: table,
    roots,
    facts,
    runs,
    minimumAgeSeconds: options.minimumAgeSeconds,
    protectedPids,
  });
  const payload = {
    roots,
    checkedAt: new Date().toISOString(),
    counts: {
      orphans: strays.length,
      failing: failing.length,
      tolerated: strays.length - failing.length,
      related: related.length,
    },
    orphans: strays,
    related,
  };
  if (options.fix) {
    if (failing.length === 0) {
      if (options.json) console.log(JSON.stringify({ ...payload, fixed: [] }, null, 2));
      else {
        console.log(
          `SKIP stray-processes: 没有需要收掉的残留进程（残留 ${strays.length} 个都未满 --min-age ${options.minimumAgeSeconds} 秒）`,
        );
      }
      return 0;
    }
    const { survivors, failures } = await stopStrays(failing, { ownPgid });
    for (const failure of failures) console.error(`  signal 失败 ${failure}`);
    payload.fixed = failing.filter((stray) => !survivors.includes(stray)).map((stray) => stray.pid);
    payload.counts.remaining = survivors.length;
    if (options.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`CLEANED stray-processes: 收掉 ${payload.fixed.length} 个残留进程`);
      for (const stray of failing.filter((entry) => survivors.includes(entry))) {
        console.log(describe(stray));
      }
    }
    if (survivors.length !== 0) {
      if (!options.json) {
        console.error(`FAIL stray-processes: ${survivors.length} 个残留进程没被收掉，需要手工处理`);
      }
      return 1;
    }
    return 0;
  }
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (strays.length === 0) {
    console.log(
      `PASS stray-processes: 没有本仓库的残留进程（本仓库相关进程 ${related.length} 个，都还在运行中）`,
    );
  } else if (failing.length === 0) {
    console.log(
      `SKIP stray-processes: ${strays.length} 个残留进程存活时间都不足 --min-age ${options.minimumAgeSeconds} 秒（pid ${strays.map((entry) => entry.pid).join(", ")}）`,
    );
  } else {
    console.error(
      `FAIL stray-processes: 发现 ${failing.length} 个残留进程（启动它们的运行已经退出）`,
    );
    for (const stray of failing) console.error(describe(stray));
    console.error("  清理：pnpm stray:fix");
  }
  return failing.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`FAIL stray-processes: ${error?.message ?? error}`);
      process.exitCode = 2;
    },
  );
}
