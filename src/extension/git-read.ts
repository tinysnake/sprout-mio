import { execFile } from "node:child_process";
import { isAbsolute, normalize, sep } from "node:path";
import { promisify } from "node:util";
import type { SproutExtensionAPI, SproutToolResult } from "./types";

const execFileAsync = promisify(execFile);

const OPERATIONS = [
  "status",
  "log",
  "show",
  "diff",
  "blame",
  "branches",
  "tags",
  "ls_files",
  "grep",
  "rev_parse",
] as const;

type Operation = (typeof OPERATIONS)[number];

export interface GitReadInput {
  operation?: Operation;
  maxCount?: number;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  grep?: string;
  pickaxe?: { mode?: "string" | "regex"; value?: string };
  ref?: string;
  from?: string;
  to?: string;
  staged?: boolean;
  startLine?: number;
  endLine?: number;
  all?: boolean;
  pattern?: string;
  glob?: string;
  ignoreCase?: boolean;
}

export interface GitReadOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

type RegisteredTool = Parameters<SproutExtensionAPI["registerTool"]>[0];
type ExecFailure = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
};

const BASE_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "core.quotePath=false",
];

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
};

const GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_NAMESPACE",
];

function fail(message: string): SproutToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { error: message },
    isError: true,
  };
}

function text(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: `${value.slice(0, maxChars)}\n[output truncated]`, truncated: true };
}

function safeText(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 必须是非空字符串。`);
  }
  if (value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`${field} 过长或包含控制字符。`);
  }
  return value;
}

function safePath(value: unknown, field = "path"): string {
  const path = safeText(value, field, 1024);
  if (isAbsolute(path)) throw new Error(`${field} 必须是仓库内相对路径。`);
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.includes("\0")) {
    throw new Error(`${field} 不能越过仓库根目录。`);
  }
  return normalized;
}

function safeRef(value: unknown, field = "ref"): string {
  const ref = safeText(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*$/.test(ref)) {
    throw new Error(`${field} 不是安全的 git ref。`);
  }
  return ref;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return safeText(value, field);
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} 必须是 ${min}..${max} 的整数。`);
  }
  return value;
}

function optionalPath(value: unknown): string | undefined {
  return value === undefined ? undefined : safePath(value);
}

function buildArgs(input: GitReadInput): string[] {
  const operation = input.operation;
  switch (operation) {
    case "status":
      return ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"];
    case "log": {
      const args = [
        "log",
        "--no-color",
        "--date=iso-strict",
        "--format=%H%x09%h%x09%an%x09%aI%x09%s",
        `--max-count=${boundedInteger(input.maxCount, "maxCount", 1, 100) ?? 20}`,
      ];
      const author = optionalString(input.author, "author");
      const since = optionalString(input.since, "since");
      const until = optionalString(input.until, "until");
      const grep = optionalString(input.grep, "grep");
      if (author) args.push(`--author=${author}`);
      if (since) args.push(`--since=${since}`);
      if (until) args.push(`--until=${until}`);
      if (grep) args.push(`--grep=${grep}`);
      if (input.pickaxe !== undefined) {
        if (typeof input.pickaxe !== "object" || input.pickaxe === null) {
          throw new Error("pickaxe 必须是 { mode, value }。");
        }
        const mode = input.pickaxe.mode ?? "string";
        if (mode !== "string" && mode !== "regex") {
          throw new Error("pickaxe.mode 必须是 string 或 regex。");
        }
        const value = safeText(input.pickaxe.value, "pickaxe.value", 512);
        args.push(mode === "string" ? `-S${value}` : `-G${value}`);
      }
      const path = optionalPath(input.path);
      if (path) args.push("--", path);
      return args;
    }
    case "show": {
      const ref = safeRef(input.ref);
      const path = optionalPath(input.path);
      const args = [
        "show",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--date=iso-strict",
        "--format=fuller",
        "--stat",
        ref,
      ];
      if (path) args.push("--", path);
      return args;
    }
    case "diff": {
      const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
      if (input.staged === true) args.push("--cached");
      const from = input.from === undefined ? undefined : safeRef(input.from, "from");
      const to = input.to === undefined ? undefined : safeRef(input.to, "to");
      if (from || to) args.push(`${from ?? "HEAD"}..${to ?? "HEAD"}`);
      const path = optionalPath(input.path);
      if (path) args.push("--", path);
      return args;
    }
    case "blame": {
      const path = safePath(input.path);
      const ref = input.ref === undefined ? "HEAD" : safeRef(input.ref);
      const args = ["blame", "--date=iso-strict"];
      const start = boundedInteger(input.startLine, "startLine", 1, 10_000_000);
      const end = boundedInteger(input.endLine, "endLine", 1, 10_000_000);
      if (start !== undefined || end !== undefined) {
        if (start === undefined || end === undefined || end < start) {
          throw new Error("startLine 与 endLine 必须同时提供，且 endLine 不小于 startLine。");
        }
        args.push("-L", `${start},${end}`);
      }
      args.push(ref, "--", path);
      return args;
    }
    case "branches":
      return [
        "branch",
        "--no-color",
        ...(input.all === true ? ["--all"] : []),
        "--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)",
      ];
    case "tags":
      return [
        "tag",
        "--list",
        "--sort=-creatordate",
        "--format=%(refname:short)%09%(creatordate:iso-strict)",
      ];
    case "ls_files": {
      const path = optionalPath(input.path);
      return ["ls-files", "-z", ...(path ? ["--", path] : [])];
    }
    case "grep": {
      const pattern = safeText(input.pattern, "pattern", 512);
      const glob = optionalString(input.glob, "glob");
      const path = optionalPath(input.path);
      const args = ["grep", "-n", "--column", "--no-color", "-I"];
      if (input.ignoreCase === true) args.push("-i");
      if (glob) args.push(`--glob=${glob}`);
      args.push("-e", pattern);
      if (path) args.push("--", path);
      return args;
    }
    case "rev_parse":
      return ["rev-parse", "--verify", "--end-of-options", safeRef(input.ref)];
    default:
      throw new Error(`不支持的 git_read 操作：${JSON.stringify(input.operation)}`);
  }
}

async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ value: string; truncated: boolean }> {
  const maxChars = 128 * 1024;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV };
    for (const key of GIT_ENV_OVERRIDES) delete env[key];
    const { stdout } = await execFileAsync("git", [...BASE_ARGS, ...args], {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return text(stdout, maxChars);
  } catch (error) {
    const failure = error as ExecFailure;
    if (failure.killed || failure.signal) {
      throw new Error(`git 命令超过 ${timeoutMs}ms，已终止。`);
    }
    if (failure.code === "ENOENT") throw new Error("找不到 git 可执行文件。");
    const stderr = failure.stderr?.trim();
    if (stderr) throw new Error(stderr.slice(0, 4000));
    throw new Error(failure.message || "git 命令失败。");
  }
}

/**
 * 只读 git 工具。命令全部走 execFile 参数数组，不经过 shell；禁用 pager、外部 diff、
 * textconv、hooks 与可选锁，避免只读查询触发写盘或执行仓库配置里的程序。
 */
export function createGitReadTool(options: GitReadOptions = {}): RegisteredTool {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    name: "git_read",
    label: "Git Read",
    description:
      "以只读方式查询宿主仓库副本的 git 状态、历史、diff、blame、pickaxe、分支、标签、文件列表和 grep。operation 必填；所有 ref 与路径都限制在仓库内，不执行写命令、不访问网络、不运行 hooks 或外部 diff。",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: [...OPERATIONS] },
        maxCount: { type: "number", minimum: 1, maximum: 100 },
        path: { type: "string", description: "仓库内相对路径。" },
        author: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        grep: { type: "string" },
        pickaxe: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["string", "regex"] },
            value: { type: "string" },
          },
          required: ["value"],
          additionalProperties: false,
        },
        ref: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        staged: { type: "boolean" },
        startLine: { type: "number", minimum: 1 },
        endLine: { type: "number", minimum: 1 },
        all: { type: "boolean" },
        pattern: { type: "string" },
        glob: { type: "string" },
        ignoreCase: { type: "boolean" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    async execute(_toolCallId, parameters): Promise<SproutToolResult> {
      const input = (parameters ?? {}) as GitReadInput;
      try {
        if (typeof input !== "object" || Array.isArray(input)) {
          throw new Error("git_read 参数必须是对象。");
        }
        if (!OPERATIONS.includes(input.operation as Operation)) {
          throw new Error(`operation 必须是 ${OPERATIONS.join("、")} 之一。`);
        }
        const args = buildArgs(input);
        const output = await runGit(args, cwd, timeoutMs);
        const normalized =
          input.operation === "ls_files" ? output.value.replaceAll("\0", "\n") : output.value;
        return {
          content: [{ type: "text", text: normalized || "(no output)" }],
          details: {
            operation: input.operation,
            truncated: output.truncated,
          },
        };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function registerGitReadTool(pi: SproutExtensionAPI, options: GitReadOptions = {}): void {
  pi.registerTool(createGitReadTool(options));
}
