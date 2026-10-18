import { spawn } from "node:child_process";
import { classifyGitFailure, firstDetailLine, GitOpError } from "./errors";

export type GitOptions = { cwd?: string; timeoutMs?: number };

const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
  LANG: "C",
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * 所有 git 操作走同一个非交互子进程入口：
 * 凭据提示被禁用（含清空 credential.helper，绕开本机 GCM），超时强杀并按 stderr 分类。
 */
export function runGit(args: string[], options: GitOptions = {}): Promise<{ stdout: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-c", "credential.helper=", ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new GitOpError("repo_git_failed", `git 无法启动：${error.message}`, ""));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new GitOpError("repo_timeout", "Git 操作超时，进程已被终止", stderr));
        return;
      }
      if (code !== 0) {
        const classified = classifyGitFailure(stderr);
        const detail = firstDetailLine(stderr);
        reject(
          new GitOpError(
            classified,
            detail ? `${detail}` : `git ${args[0]} 失败 (exit ${code})`,
            stderr,
          ),
        );
        return;
      }
      resolvePromise({ stdout });
    });
  });
}
