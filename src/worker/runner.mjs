// 第三层恢复权威：执行端自己的 claim 与 result 文件。
//
// Worker 用 `detached` 起这个进程，它就是该执行的进程组组长，命令行参数是
//   <executionId> <runnerToken> <stateDirectory> <shellPath>
// 命令正文走环境变量，不进 argv：同一台机器上按命令行匹配进程的工具只该看到一个命令进程。
// 顺序很重要：先把 runner claim 落盘（pid 与 token），再起真正的命令；命令退出后再落
// result。被杀在 result 之前，磁盘上就没有结果——这正是「不猜」的可执行版本。
//
// 只用 node 内置模块，源码(tree)与打包(dist)都能直接跑，不依赖 tsx 或任何构建产物。
import { spawn } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

const [executionId, runnerToken, stateDirectory, shellPath] = process.argv.slice(2);
const command = process.env.SPROUT_RUNNER_COMMAND ?? "";

/** tmp + rename：读到的一半文件永远不会被当成事实。 */
function writeJson(directory, name, value) {
  const temporary = join(directory, `${name}.tmp`);
  const handle = openSync(temporary, "w", 0o600);
  try {
    writeSync(handle, JSON.stringify(value));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, join(directory, name));
}

// 宿主发信号的对象是「命令与它所在的进程组」。包装进程不能替命令先死：那样 Worker 会把
// 「包装进程被 TERM 打死」当成命令已停，真实的退出码与信号就再也拿不到。TERM/INT/HUP 交给
// 命令自己处理；SIGKILL 打整个组时两者一起消失，磁盘上不留结果，恢复只能报 unknown。
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});

const directory = join(stateDirectory, "executions", executionId);
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeJson(directory, "runner.json", {
  executionId,
  pid: process.pid,
  token: runnerToken,
  startedAt: new Date().toISOString(),
});

const child = spawn(shellPath, ["-lc", command], { stdio: "inherit" });
// 命令的 pid 单独记：工具面与页面看到的是「命令」，不是这个包装进程。
writeJson(directory, "runner.json", {
  executionId,
  pid: process.pid,
  childPid: child.pid ?? null,
  token: runnerToken,
  startedAt: new Date().toISOString(),
});
const [code, signal] = await new Promise((resolve) => {
  child.once("error", () => resolve([127, null]));
  child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
});
writeJson(directory, "result.json", {
  executionId,
  exitCode: code,
  signal,
  exitedAt: new Date().toISOString(),
});
// 信号语义由 result.json 承载；进程退出码只用来让 Worker 立刻知道「子进程已停」。
process.exitCode = code ?? 1;
