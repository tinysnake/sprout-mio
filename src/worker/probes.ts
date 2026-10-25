import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import type { CapabilitySnapshot, DirectoryObservation, ShellFact } from "../contracts/machine";
import { projectWorkingPath } from "../contracts/machine";
import type { WorkerSession } from "../contracts/worker-session";
import { APP_VERSION } from "../contracts/version";

/** Only operations implemented by the gated dispatcher are advertised. */
const REGISTERED_REMOTE_OPERATIONS: CapabilitySnapshot["remoteOperations"] = [
  "shell",
  "file_read",
  "file_write",
  "process_list",
  "process_signal",
];

function execute(path: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      path,
      args,
      {
        timeout: 3000,
        maxBuffer: 4096,
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/var/empty",
          BASH_ENV: "/dev/null",
          ENV: "/dev/null",
          ZDOTDIR: "/var/empty",
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    ),
  );
}
function shellFailure(
  error: unknown,
): "missing" | "denied" | "timeout" | "failed" | "output_limit" {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "ENOENT") return "missing";
    if ("code" in error && error.code === "EACCES") return "denied";
    if ("code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      return "output_limit";
    if ("killed" in error && error.killed) return "timeout";
  }
  return "failed";
}
async function shell(path: string, checkedAt: string): Promise<ShellFact> {
  const kind: ShellFact["kind"] =
    path === "/bin/zsh"
      ? "zsh"
      : path === "/bin/bash"
        ? "bash"
        : path === "/bin/sh"
          ? "sh"
          : "unknown";
  const fact = { path, kind, checkedAt, version: null };
  if (kind === "unknown") return { ...fact, probe: { kind: "failure", reason: "unsupported" } };
  try {
    const flags = kind === "zsh" ? ["-f"] : kind === "bash" ? ["--noprofile", "--norc"] : [];
    const version = await execute(path, [...flags, "--version"]);
    if ((await execute(path, [...flags, "-c", "printf sprout-shell-ok"])) !== "sprout-shell-ok")
      throw new Error("Self check failed");
    return { ...fact, version: version.slice(0, 4096), probe: { kind: "success" } };
  } catch (error) {
    return { ...fact, probe: { kind: "failure", reason: shellFailure(error) } };
  }
}
export async function probeCapability(checkedAt: string): Promise<CapabilitySnapshot> {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64"))
    throw new Error("Worker requires macOS arm64 or x64");
  const paths = [
    ...new Set(
      [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
        (path): path is string =>
          !!path && path.startsWith("/") && !path.includes("\0") && path.length <= 4096,
      ),
    ),
  ];
  const shells = await Promise.all(paths.map((path) => shell(path, checkedAt)));
  return {
    mcpRelay: { version: 1, transports: ["stdio", "streamableHttp"], maxMessageBytes: 131072 },
    platform: "darwin",
    arch: process.arch,
    workerVersion: APP_VERSION,
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
    revision: rootRevision,
    seq,
    checkedAt,
    result,
  };
}
