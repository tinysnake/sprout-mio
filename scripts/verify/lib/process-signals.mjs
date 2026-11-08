import { spawnSync } from "node:child_process";

/** 探针（ps）自己不可用时返回 null：满载机器上 ps 可能超时，「不知道」必须区别于「确实没进程」。 */
export function groupHasLiveProcess(pid) {
  const snapshot = spawnSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (snapshot.status !== 0) return null;
  return snapshot.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && !state?.startsWith("Z");
  });
}

export function reportSignalFailure(pid, signal, error, { write = writeStderr } = {}) {
  const line = `verify: signal ${signal} to process ${pid} failed: ${error.message} (残留进程需手工清理)\n`;
  write(line);
  return line;
}

// 发信号只是尽力而为：目标进程组可能已经退出（macOS 对已消失的组回 EPERM 而不是 ESRCH），探针
// 也可能跑不动。两种情况下少杀一个残留进程都比打死 runner 好——中断运行还要写报告、按 130/143
// 退出（记录过一次 EPERM 抛成未捕获异常，退出码从 143 变成 1、报告也没写成）。
export function signalProcessGroup(
  pid,
  signal,
  { kill = killProcessGroup, group = groupHasLiveProcess, report = reportSignalFailure } = {},
) {
  try {
    kill(-pid, signal);
    return { delivered: true, reported: false };
  } catch (error) {
    if (error.code === "ESRCH") return { delivered: false, reported: false };
    if (error.code === "EPERM" && group(pid) === false)
      return { delivered: false, reported: false };
    report(pid, signal, error);
    return { delivered: false, reported: true };
  }
}

function killProcessGroup(pid, signal) {
  process.kill(pid, signal);
}

function writeStderr(line) {
  process.stderr.write(line);
}
