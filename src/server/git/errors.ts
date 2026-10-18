import type { RepoErrorCode } from "../../contracts/repository";

export class GitOpError extends Error {
  constructor(
    readonly code: RepoErrorCode,
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitOpError";
  }
}

/** 顺序重要：认证信号先于远端不可达，ssh 拒绝与 401 都归认证失败。 */
const PATTERNS: readonly (readonly [RepoErrorCode, RegExp])[] = [
  [
    "repo_auth_failed",
    /Authentication failed|could not read Username|terminal prompts disabled|Permission denied|returned error: 401|credentials are required/i,
  ],
  [
    "repo_ref_not_found",
    /couldn't find remote ref|Remote branch .* not found|invalid reference|not our ref|unknown revision|bad revision|pathspec .* did not match/i,
  ],
  ["repo_remote_not_found", /does not appear to be a git repository|Repository not found/i],
  [
    "repo_remote_unreachable",
    /Could not resolve host|Could not read from remote repository|Connection refused|Connection timed out|Failed to connect|no such host|Network is unreachable/i,
  ],
];

export const GIT_ERROR_MESSAGES: Record<RepoErrorCode, string> = {
  repo_unconfigured: "Project 未配置 gitRemote 或 workDirectory",
  repo_workdir_missing: "工作副本不存在或不是目录",
  repo_workdir_invalid: "工作副本不是可用的 git 仓库",
  repo_remote_not_found: "远端仓库不存在",
  repo_remote_unreachable: "远端不可达",
  repo_auth_failed: "Git 认证失败",
  repo_ref_not_found: "Git ref 不存在",
  repo_timeout: "Git 操作超时",
  repo_disk_limit: "工作副本占用超过磁盘上限",
  repo_git_failed: "Git 操作失败",
};

export function classifyGitFailure(stderr: string): RepoErrorCode {
  for (const [code, pattern] of PATTERNS) if (pattern.test(stderr)) return code;
  return "repo_git_failed";
}

/** 只取 stderr 的 fatal 首行做可读消息，不把可能含凭据的完整输出透出到 run 错误。 */
export function firstDetailLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const fatal = lines.find((line) => /^fatal:/i.test(line));
  return (fatal ?? lines[0] ?? "").slice(0, 300);
}
