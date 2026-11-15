import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { projectWorkingPath } from "../contracts/machine";
import {
  MACHINE_BROWSE_CHUNK_BYTES,
  MACHINE_BROWSE_MAX_COMMANDS,
  MACHINE_BROWSE_MAX_ENTRIES,
  type MachineBrowseCommand,
  type MachineBrowseDirListResult,
  type MachineBrowseEntry,
  type MachineBrowseFailureCode,
  type MachineBrowseFailureResult,
  type MachineBrowseFileChunkResult,
  type MachineBrowseResult,
} from "../contracts/machine-browse";
import type { WorkerExchangeResponse } from "../contracts/worker";

export type BrowseConfiguration = NonNullable<
  Extract<WorkerExchangeResponse, { ok: true }>["data"]["configuration"]
>;

export class BrowseError extends Error {
  constructor(
    readonly code: MachineBrowseFailureCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 路径按 `/` 拆段后逐段校验；反斜杠在 POSIX 上是合法文件名字符，
 * 但这里接受的是跨机器的相对路径，统一按分隔符处理才不会让两端理解不一致。
 */
export function browsePathSegments(input: string): string[] {
  if (input.includes("\0")) throw new BrowseError("validation_failed", "路径包含 NUL");
  if (input.includes("\\")) throw new BrowseError("validation_failed", "路径不能包含反斜杠");
  if (input.startsWith("/")) throw new BrowseError("validation_failed", "路径必须是相对路径");
  if (input === "") return [];
  const segments = input.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      throw new BrowseError("validation_failed", "路径包含无效段");
  }
  return segments;
}

export function insideRoot(rootReal: string, candidate: string): boolean {
  return candidate === rootReal || candidate.startsWith(rootReal + sep);
}

async function realpathOrThrow(path: string, code: MachineBrowseFailureCode, message: string) {
  try {
    return await realpath(path);
  } catch {
    throw new BrowseError(code, message);
  }
}

/**
 * 围栏根取 Project 自己的工作目录，而不是 Machine 根：两台 Project 共用一个根时，
 * 互相看不到对方的产物。
 */
export async function openBrowseBase(root: string, projectId: string): Promise<string> {
  const rootReal = await realpathOrThrow(root, "forbidden", "Machine 根目录无法解析");
  const baseReal = await realpathOrThrow(
    projectWorkingPath(rootReal, projectId),
    "not_found",
    "项目工作目录不存在",
  );
  if (!insideRoot(rootReal, baseReal))
    throw new BrowseError("forbidden", "项目工作目录在根目录之外");
  return baseReal;
}

async function resolveInside(
  baseReal: string,
  segments: string[],
  missing: MachineBrowseFailureCode,
): Promise<string> {
  const literal = resolve(baseReal, ...segments);
  if (!insideRoot(baseReal, literal)) throw new BrowseError("forbidden", "路径在项目工作目录之外");
  const resolved = await realpathOrThrow(literal, missing, "路径不存在");
  if (!insideRoot(baseReal, resolved)) throw new BrowseError("forbidden", "路径在项目工作目录之外");
  return resolved;
}

function entryOf(info: {
  name: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs: number;
  symlink: boolean;
}): MachineBrowseEntry {
  return {
    name: info.name,
    kind: info.kind,
    ...(info.kind === "file" ? { size: info.size } : {}),
    modifiedAt: new Date(info.mtimeMs).toISOString(),
    symlink: info.symlink,
  };
}

async function describeEntry(
  baseReal: string,
  directory: string,
  name: string,
): Promise<MachineBrowseEntry | null> {
  const fullPath = resolve(directory, name);
  const link = await lstat(fullPath).catch(() => null);
  if (!link) return null;
  if (link.isSymbolicLink()) {
    const resolved = await realpath(fullPath).catch(() => null);
    if (!resolved || !insideRoot(baseReal, resolved)) return null;
    const target = await stat(resolved).catch(() => null);
    if (!target) return null;
    if (!target.isDirectory() && !target.isFile()) return null;
    return entryOf({
      name,
      kind: target.isDirectory() ? "directory" : "file",
      size: target.size,
      mtimeMs: target.mtimeMs,
      symlink: true,
    });
  }
  if (!link.isDirectory() && !link.isFile()) return null;
  return entryOf({
    name,
    kind: link.isDirectory() ? "directory" : "file",
    size: link.size,
    mtimeMs: link.mtimeMs,
    symlink: false,
  });
}

export async function listBrowseDirectory(
  root: string,
  projectId: string,
  relativePath: string,
): Promise<Pick<MachineBrowseDirListResult, "path" | "realPath" | "entries" | "truncated">> {
  const segments = browsePathSegments(relativePath);
  const baseReal = await openBrowseBase(root, projectId);
  const directory = await resolveInside(baseReal, segments, "not_found");
  const names = await readdir(directory).catch(() => {
    throw new BrowseError("not_found", "目录不可读");
  });
  const entries: MachineBrowseEntry[] = [];
  for (const name of names) {
    if (name === ".git") continue;
    const entry = await describeEntry(baseReal, directory, name);
    if (entry) entries.push(entry);
  }
  entries.sort((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name, "zh-Hans", {
          numeric: true,
          sensitivity: "base",
        })
      : left.kind === "directory"
        ? -1
        : 1,
  );
  return {
    path: segments.join("/"),
    realPath: directory,
    entries: entries.slice(0, MACHINE_BROWSE_MAX_ENTRIES),
    truncated: entries.length > MACHINE_BROWSE_MAX_ENTRIES,
  };
}

export type BrowseFileChunk = Pick<
  MachineBrowseFileChunkResult,
  "path" | "realPath" | "totalSize" | "offset" | "mtimeMs" | "base64" | "eof"
>;

export async function readBrowseFileChunk(
  root: string,
  projectId: string,
  relativePath: string,
  options: { offset?: number; maxBytes?: number } = {},
): Promise<BrowseFileChunk> {
  const segments = browsePathSegments(relativePath);
  if (segments.length === 0) throw new BrowseError("validation_failed", "缺少文件路径");
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new BrowseError("validation_failed", "读取偏移无效");
  const maxBytes = Math.min(
    options.maxBytes ?? MACHINE_BROWSE_CHUNK_BYTES,
    MACHINE_BROWSE_CHUNK_BYTES,
  );
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new BrowseError("validation_failed", "读取长度无效");
  const baseReal = await openBrowseBase(root, projectId);
  const target = await resolveInside(baseReal, segments, "not_found");
  const before = await stat(target).catch(() => {
    throw new BrowseError("not_found", "文件不存在");
  });
  if (!before.isFile()) throw new BrowseError("validation_failed", "目标不是文件");
  if (offset > before.size) throw new BrowseError("validation_failed", "读取偏移超过文件大小");
  const path = segments.join("/");
  if (offset === before.size)
    return {
      path,
      realPath: target,
      totalSize: before.size,
      offset,
      mtimeMs: before.mtimeMs,
      base64: "",
      eof: true,
    };
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new BrowseError("forbidden", "文件不可读");
  });
  try {
    // realpath 与 open 之间目标可能被换掉：打开后再比一次 inode。
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino)
      throw new BrowseError("forbidden", "文件在读取前被替换");
    if (!after.isFile()) throw new BrowseError("validation_failed", "目标不是文件");
    if (offset > after.size) throw new BrowseError("validation_failed", "读取偏移超过文件大小");
    const want = Math.min(maxBytes, after.size - offset);
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, offset);
    return {
      path,
      realPath: target,
      totalSize: after.size,
      offset,
      mtimeMs: after.mtimeMs,
      base64: buffer.subarray(0, bytesRead).toString("base64"),
      eof: offset + bytesRead >= after.size,
    };
  } finally {
    await handle.close();
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function failureOf(requestId: string, error: unknown): MachineBrowseFailureResult {
  if (error instanceof BrowseError) {
    return { requestId, ok: false, code: error.code, message: error.message };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return { requestId, ok: false, code: "not_found", message: "路径不存在" };
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP")
    return { requestId, ok: false, code: "forbidden", message: "没有读取权限" };
  return { requestId, ok: false, code: "validation_failed", message: "浏览失败" };
}

const RESULT_TTL_MS = 60_000;
const COMPLETED_LIMIT = 512;

/**
 * 结果先进队列，等交换成功才提交：失败的那次交换可能已被服务端记账，
 * 提前丢弃会让路由永远等不到回应。
 */
export class BrowseBus {
  private configuration: BrowseConfiguration | null = null;
  private readonly inflight = new Set<string>();
  private readonly completed = new Map<string, MachineBrowseResult>();
  private results: Array<{ result: MachineBrowseResult; at: number }> = [];

  constructor(
    private readonly machineId: string,
    private readonly now: () => number = Date.now,
  ) {}

  configure(configuration: BrowseConfiguration | null) {
    this.configuration = configuration;
  }

  accept(commands: MachineBrowseCommand[]) {
    for (const command of commands) {
      if (this.inflight.has(command.requestId) || this.completed.has(command.requestId)) continue;
      this.inflight.add(command.requestId);
      void this.run(command);
    }
  }

  private async run(command: MachineBrowseCommand) {
    let result: MachineBrowseResult;
    try {
      result = await this.execute(command);
    } catch (error) {
      result = failureOf(command.requestId, error);
    }
    this.inflight.delete(command.requestId);
    if (this.completed.size >= COMPLETED_LIMIT) {
      const oldest = this.completed.keys().next().value;
      if (oldest) this.completed.delete(oldest);
    }
    this.completed.set(command.requestId, result);
    this.results.push({ result, at: this.now() });
  }

  private async execute(command: MachineBrowseCommand): Promise<MachineBrowseResult> {
    if (command.machineId !== this.machineId)
      throw new BrowseError("forbidden", "命令不属于这台 Machine");
    const configuration = this.configuration;
    if (!configuration?.root) throw new BrowseError("forbidden", "尚未收到可用的根目录配置");
    if (!configuration.bindings.some((binding) => binding.projectId === command.projectId))
      throw new BrowseError("forbidden", "Project 未绑定到这台 Machine");
    if (command.op === "dir_list") {
      const listed = await listBrowseDirectory(configuration.root, command.projectId, command.path);
      return { requestId: command.requestId, ok: true, op: "dir_list", ...listed };
    }
    if (command.op !== "file_chunk") throw new BrowseError("validation_failed", "不支持的浏览操作");
    const chunk = await readBrowseFileChunk(configuration.root, command.projectId, command.path, {
      offset: command.offset,
      maxBytes: command.maxBytes,
    });
    return { requestId: command.requestId, ok: true, op: "file_chunk", ...chunk };
  }

  outgoing(maxBytes: number): MachineBrowseResult[] {
    const now = this.now();
    this.results = this.results.filter((item) => now - item.at < RESULT_TTL_MS);
    const picked: MachineBrowseResult[] = [];
    let used = 0;
    for (const item of this.results) {
      if (picked.length >= MACHINE_BROWSE_MAX_COMMANDS) break;
      const cost = jsonBytes(item.result) + 1;
      if (used + cost > maxBytes) continue;
      used += cost;
      picked.push(item.result);
    }
    return picked;
  }

  commit(sent: MachineBrowseResult[]) {
    if (sent.length === 0) return;
    const ids = new Set(sent.map((result) => result.requestId));
    this.results = this.results.filter((item) => !ids.has(item.result.requestId));
    for (const id of ids) this.completed.delete(id);
  }
}
