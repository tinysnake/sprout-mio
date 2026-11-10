import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { ExecutionSessionKind, ShellFact } from "../contracts/machine";

export type ShellKind = ShellFact["kind"];
export type ProcessItem = { pid: number; command: string };

/**
 * 每个 shell 的调用方式。命令正文整体作为一个 argv 元素交给 shell，不拼引号、不解析文本；
 * PowerShell 7 与 Windows PowerShell 共用 `-Command`，它们的区别只在可执行文件与版本。
 */
export function shellInvocation(
  shellPath: string,
  kind: ShellKind,
  text: string,
): { file: string; args: string[] } {
  if (kind === "pwsh" || kind === "powershell")
    return {
      file: shellPath,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", text],
    };
  if (kind === "cmd") return { file: shellPath, args: ["/d", "/s", "/c", text] };
  return { file: shellPath, args: ["-lc", text] };
}

/**
 * Windows 没有可送达的 SIGTERM：Task Manager 之外唯一可靠的树终止是 `taskkill /T /F`。
 * 因此 win32 上两种策略都是强制终止，调用方必须如实报 `kill_delivered`，不能报 `term_delivered`。
 */
export function processTreeKillIsForced(): boolean {
  return process.platform === "win32";
}

/** 只报告 OS 是否接受这次调用；接受不等于进程已停。 */
export function killProcessTree(pid: number): boolean {
  if (process.platform === "win32") {
    const result = spawnSync(
      process.env.SystemRoot
        ? join(process.env.SystemRoot, "System32", "taskkill.exe")
        : "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10000,
      },
    );
    return result.status === 0;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/** 单进程信号：POSIX 原样转发；Windows 上 TERM/INT/KILL 都退化为强制终止。 */
export function signalProcess(pid: number, signal: "TERM" | "INT" | "KILL"): boolean {
  try {
    process.kill(pid, `SIG${signal}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 工具面看到的「进程」在 Windows 上是一个 shell，终止它必须连子进程一起打，
 * 否则退出码落盘了、子进程还在跑。POSIX 仍按单 pid 转发调用方指定的信号。
 */
export function signalProcessTree(pid: number, signal: "TERM" | "INT" | "KILL"): boolean {
  return process.platform === "win32" ? killProcessTree(pid) : signalProcess(pid, signal);
}

/** Windows `tasklist /FO CSV /NH` 的一行：CSV 字段可含逗号与双引号，必须按 CSV 解析。 */
export function parseTasklistCsv(output: string): ProcessItem[] {
  const items: ProcessItem[] = [];
  for (const row of output.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const fields = parseCsvRow(row);
    const pid = Number(fields[1]);
    if (!fields[0] || !Number.isSafeInteger(pid) || pid <= 0) continue;
    items.push({ pid, command: fields[0] });
  }
  return items;
}
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < row.length; index++) {
    const char = row[index];
    if (quoted) {
      if (char === '"') {
        if (row[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      fields.push(field);
      field = "";
    } else field += char;
  }
  fields.push(field);
  return fields;
}

/** POSIX 进程列表：`ps -axo pid=,comm=` 每行「pid 命令名」。 */
export function parsePsOutput(output: string): ProcessItem[] {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

/**
 * 只做 SessionId 到语义的映射：0 是服务会话，其余是交互桌面。
 * 读不到 SessionId 时调用方必须报 unknown，不能落到任何一个分支。
 */
export function executionSessionKind(sessionId: number): ExecutionSessionKind {
  return sessionId === 0 ? "service_session_0" : "interactive_desktop";
}

/** 进程列表：POSIX 走 `ps`，Windows 走 `tasklist` 的 CSV 输出。两条路径都只读操作系统
 * 已经结构化的事实，不靠 shell 文本做文件操作。 */
export function spawnProcessList(): ChildProcessByStdio<null, Readable, Readable> {
  const [file, args] =
    process.platform === "win32"
      ? (["tasklist", ["/FO", "CSV", "/NH"]] as const)
      : (["/bin/ps", ["-axo", "pid=,comm="]] as const);
  return spawn(file, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessByStdio<null, Readable, Readable>;
}
