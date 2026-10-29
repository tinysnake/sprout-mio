// 第三层恢复权威：执行端自己的 claim 与 result 文件。
//
// 托管分离：Worker 用 `detached` 起这个进程，它自己就是一条独立的观察者；命令再由它用
// **自己的**进程组起（`detached: true`）。Worker 的中止信号只打命令组，runner 不陪葬，
// 于是 KILL 之后 result.json 仍然会落盘——退出是被观测到的，不是「不知道它怎么结束」。
//
// 命令行参数是 <executionId> <runnerToken> <stateDirectory> <shellPath>；
// 命令正文走环境变量，不进 argv：同一台机器上按命令行匹配进程的工具只该看到一个命令进程。
//
// 顺序很重要：先把 runner claim（pid 与 token）落盘，再起真正的命令；命令起来后立刻把
// childPid 补进同一份 claim（Worker 的信号目标从这里解析）；命令退出后再落 result。
// 被 KILL 在 result 之前（宿主断电、runner 自己也被杀），磁盘上就没有结果——这正是「不猜」
// 的可执行版本。
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

// Worker 在 childPid 落盘前只能按旧行为把信号打到这里所在的组。观察者不能替命令先死：
// 那样 Worker 会把「runner 被 TERM 打死」当成命令已停，真实的退出码与信号就再也落不了盘。
// 这个窗口只有一次 spawn 的宽度；宽限到点时 Worker 会重新解析 childPid，改打命令组。
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});

const directory = join(stateDirectory, "executions", executionId);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const claim = {
  executionId,
  pid: process.pid,
  token: runnerToken,
  startedAt: new Date().toISOString(),
};
writeJson(directory, "runner.json", claim);

// detached：命令自成进程组，组号就是 child.pid。Worker 的取消/超时信号打 -childPid，
// runner 留在自己的组里继续当观察者。stdio 继承，日志帧仍然直达 Worker 的管道。
const child = spawn(shellPath, ["-lc", command], { stdio: "inherit", detached: true });
// 命令的 pid 单独记：工具面、页面与信号目标看到的是「命令」，不是这个包装进程。
writeJson(directory, "runner.json", { ...claim, childPid: child.pid ?? null });
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
