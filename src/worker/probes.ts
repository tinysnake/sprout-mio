import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type {
  CapabilitySnapshot,
  DirectoryObservation,
  ExecutionEnvironment,
  ShellFact,
} from "../contracts/machine";
import { isAbsolutePath, projectWorkingPath } from "../contracts/machine";
import type { WorkerSession } from "../contracts/worker-session";
import { APP_VERSION } from "../contracts/version";
import { executionSessionKind } from "./platform";

/** Only operations implemented by the gated dispatcher are advertised. */
const REGISTERED_REMOTE_OPERATIONS: CapabilitySnapshot["remoteOperations"] = [
  "shell",
  "file_read",
  "file_write",
  "process_list",
  "process_signal",
];
const POWERSHELL_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

function execute(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv = posixProbeEnvironment(),
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      path,
      args,
      { timeout: 3000, maxBuffer: 4096, encoding: "utf8", env, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    ),
  );
}
function posixProbeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/var/empty",
    BASH_ENV: "/dev/null",
    ENV: "/dev/null",
    ZDOTDIR: "/var/empty",
  };
}
/**
 * 探测只读不写：Windows 上给 PowerShell 一个最小但合法的环境，不把当前用户的
 * profile 或 PATH 注入探测命令，也不改用户的控制台编码。
 */
function windowsProbeEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return {
    SystemRoot: systemRoot,
    SystemDrive: process.env.SystemDrive ?? "C:",
    windir: process.env.windir ?? systemRoot,
    ComSpec: process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"),
    PATH: process.env.PATH ?? join(systemRoot, "System32"),
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    TEMP: process.env.TEMP ?? join(systemRoot, "Temp"),
    TMP: process.env.TMP ?? process.env.TEMP ?? join(systemRoot, "Temp"),
    USERPROFILE: process.env.USERPROFILE ?? "",
    POWERSHELL_TELEMETRY_OPTOUT: "1",
    POWERSHELL_UPDATECHECK: "Off",
  };
}
function probeEnvironment(): NodeJS.ProcessEnv {
  return process.platform === "win32" ? windowsProbeEnvironment() : posixProbeEnvironment();
}
function shellFailure(
  error: unknown,
): "missing" | "denied" | "timeout" | "failed" | "output_limit" {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "ENOENT") return "missing";
    if ("code" in error && (error.code === "EACCES" || error.code === "EPERM")) return "denied";
    if ("code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      return "output_limit";
    if ("killed" in error && error.killed) return "timeout";
  }
  return "failed";
}
function posixShellKind(path: string): ShellFact["kind"] {
  return path === "/bin/zsh"
    ? "zsh"
    : path === "/bin/bash"
      ? "bash"
      : path === "/bin/sh"
        ? "sh"
        : "unknown";
}
/** 可执行文件名决定身份：pwsh 是 PowerShell 7，powershell 是 Windows PowerShell。 */
function windowsShellKind(path: string): ShellFact["kind"] {
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  return name === "pwsh.exe"
    ? "pwsh"
    : name === "powershell.exe"
      ? "powershell"
      : name === "cmd.exe"
        ? "cmd"
        : "unknown";
}
async function shell(path: string, kind: ShellFact["kind"], checkedAt: string): Promise<ShellFact> {
  const fact = { path, kind, checkedAt, version: null };
  if (kind === "unknown") return { ...fact, probe: { kind: "failure", reason: "unsupported" } };
  try {
    const env = probeEnvironment();
    let version: string;
    if (kind === "pwsh" || kind === "powershell") {
      version = await execute(
        path,
        [...POWERSHELL_FLAGS, "-Command", "$PSVersionTable.PSVersion.ToString()"],
        env,
      );
      if (
        (await execute(
          path,
          [...POWERSHELL_FLAGS, "-Command", "Write-Output sprout-shell-ok"],
          env,
        )) !== "sprout-shell-ok"
      )
        throw new Error("Self check failed");
    } else if (kind === "cmd") {
      const banner = await execute(path, ["/d", "/c", "ver"], env);
      // cmd 的版本横幅随系统语言本地化；只保留与语言无关的数字版本。
      const numeric = /\d+(?:\.\d+)+/.exec(banner)?.[0];
      if (!numeric) throw new Error("Version banner has no version number");
      version = numeric;
      if ((await execute(path, ["/d", "/c", "echo sprout-shell-ok"], env)) !== "sprout-shell-ok")
        throw new Error("Self check failed");
    } else {
      const flags = kind === "zsh" ? ["-f"] : kind === "bash" ? ["--noprofile", "--norc"] : [];
      version = await execute(path, [...flags, "--version"], env);
      if (
        (await execute(path, [...flags, "-c", "printf sprout-shell-ok"], env)) !== "sprout-shell-ok"
      )
        throw new Error("Self check failed");
    }
    return { ...fact, version: version.slice(0, 4096), probe: { kind: "success" } };
  } catch (error) {
    return { ...fact, probe: { kind: "failure", reason: shellFailure(error) } };
  }
}
/** 在 PATH 里按文件名找可执行文件：直接查文件系统，不经过 shell。 */
export function findOnPath(
  name: string,
  path: string | undefined = process.env.PATH,
): string | null {
  for (const directory of (path ?? "").split(delimiter)) {
    const candidate = join(directory.replace(/^"|"$/g, ""), name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function windowsShellCandidates(): { path: string; kind: ShellFact["kind"] }[] {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = [
    findOnPath("pwsh.exe") ?? join(programFiles, "PowerShell", "7", "pwsh.exe"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe"),
  ];
  const seen = new Set<string>();
  return candidates
    .filter((path) => isAbsolutePath(path) && !path.includes("\0") && path.length <= 4096)
    .filter((path) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((path) => ({ path, kind: windowsShellKind(path) }));
}
/**
 * 实际执行环境只报能读到的事实。Windows 服务（sshd 等）落在 Session 0，和交互桌面
 * 不是同一个环境；读不到 SessionId 时给 null + 启发式，不把 0 当成默认值。
 */
async function executionEnvironment(shells: ShellFact[]): Promise<ExecutionEnvironment> {
  if (process.platform !== "win32") return { sessionId: null, sessionKind: "not_applicable" };
  const powershell = shells.find(
    (fact) => (fact.kind === "pwsh" || fact.kind === "powershell") && fact.probe.kind === "success",
  );
  if (powershell) {
    try {
      const output = await execute(
        powershell.path,
        [...POWERSHELL_FLAGS, "-Command", "(Get-Process -Id $PID).SessionId"],
        probeEnvironment(),
      );
      const sessionId = Number.parseInt(output, 10);
      if (Number.isSafeInteger(sessionId) && sessionId >= 0)
        return { sessionId, sessionKind: executionSessionKind(sessionId) };
    } catch {
      // 读不到就退回环境变量，不编造一个 SessionId。
    }
  }
  const name = process.env.SESSIONNAME ?? "";
  if (/^services$/i.test(name)) return { sessionId: null, sessionKind: "service_session_0" };
  if (/^(console|rdp-|ica-)/i.test(name))
    return { sessionId: null, sessionKind: "interactive_desktop" };
  return { sessionId: null, sessionKind: "unknown" };
}
export async function probeCapability(checkedAt: string): Promise<CapabilitySnapshot> {
  if (
    (process.platform !== "darwin" && process.platform !== "win32") ||
    (process.arch !== "arm64" && process.arch !== "x64")
  )
    throw new Error("Worker requires macOS or Windows on arm64 or x64");
  const shells =
    process.platform === "win32"
      ? await Promise.all(
          windowsShellCandidates().map(({ path, kind }) => shell(path, kind, checkedAt)),
        )
      : await Promise.all(
          [
            ...new Set(
              [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
                (path): path is string =>
                  !!path && path.startsWith("/") && !path.includes("\0") && path.length <= 4096,
              ),
            ),
          ].map((path) => shell(path, posixShellKind(path), checkedAt)),
        );
  return {
    mcpRelay: { version: 1, transports: ["stdio", "streamableHttp"], maxMessageBytes: 131072 },
    platform: process.platform === "win32" ? "win32" : "darwin",
    arch: process.arch,
    workerVersion: APP_VERSION,
    // 探测的是「现在这台机器上的实际执行环境」，与 Worker 连接代次一起上报。
    executionEnvironment: await executionEnvironment(shells),
    shells,
    remoteOperations: REGISTERED_REMOTE_OPERATIONS.filter(
      (kind) => kind !== "shell" || shells.some((fact) => fact.probe.kind === "success"),
    ),
  };
}
export async function probeDirectory(
  root: string,
  projectId: string,
  rootRevision: number,
  bindingRevision: number,
  session: WorkerSession,
  seq: number,
  checkedAt: string,
): Promise<DirectoryObservation> {
  let result: DirectoryObservation["result"];
  try {
    const path = projectWorkingPath(root, projectId);
    if (!(await stat(path)).isDirectory())
      result = { kind: "unavailable", reason: "not_directory" };
    else {
      const resolved = await realpath(path);
      await access(resolved, constants.R_OK | constants.W_OK | constants.X_OK);
      result = { kind: "accessible", realPath: resolved };
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    result = {
      kind: "unavailable",
      reason:
        code === "ENOENT"
          ? "missing"
          : code === "ENOTDIR"
            ? "not_directory"
            : code === "EACCES" || code === "EPERM"
              ? "denied"
              : "io_error",
    };
  }
  return {
    machineId: session.machineId,
    generation: session.generation,
    projectId,
    bindingRevision,
    revision: rootRevision,
    seq,
    checkedAt,
    result,
  };
}
