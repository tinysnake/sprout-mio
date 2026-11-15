import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { Readable } from "node:stream";
import type { WorkspaceEntry, WorkspacePreviewKind, WorkspaceTree } from "../contracts/workspace";
import { WORKSPACE_TREE_MAX_ENTRIES } from "../contracts/workspace";
import { workspaceContentType, workspacePreviewKind } from "../lib/workspace-preview";
import { piInstanceWorkspacePath } from "../lib/pi-instance-path";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { listInstancesForChat } from "./chat";
import { getProjectRepoState } from "./repository";

/**
 * 工作区读取只复用 app 错误码：越界不是「这台机器不可用」，而是这次请求指向了
 * 工作区之外。`forbidden` 同时覆盖 symlink 解析后落到根外这一情形。
 */
export class WorkspaceError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "validation_failed",
    message: string,
  ) {
    super(message);
  }
}

export type WorkspaceRootKind = "repository" | "workspace";

export type ActiveWorkspaceRoot = {
  readonly kind: WorkspaceRootKind;
  readonly path: string;
  readonly label: string;
};

const ROOT_LABEL: Record<WorkspaceRootKind, string> = {
  repository: "Project 工作副本",
  workspace: "Chat 工作区",
};

/**
 * 根由 Chat 归属的 Project 决定：有工作副本就浏览副本（这是 agent 真正改代码的地方），
 * 没有就浏览该 Chat 的 Pi 实例工作目录。两者都不需要租约，也不需要 agent 在线。
 */
export function resolveWorkspaceRoot(
  projectId: string,
  chatId: string | undefined,
  ctx: ProjectContext,
): ActiveWorkspaceRoot | undefined {
  assertProjectAccess(ctx, projectId);
  const checkout = getProjectRepoState(projectId, ctx).checkout;
  if (checkout) return { kind: "repository", path: checkout.path, label: ROOT_LABEL.repository };
  if (!chatId) return undefined;
  const instance = listInstancesForChat(chatId, ctx)[0];
  if (!instance) return undefined;
  return {
    kind: "workspace",
    path: piInstanceWorkspacePath(instance.id),
    label: ROOT_LABEL.workspace,
  };
}

/** 绝对路径、`.`、`..`、NUL 与反斜杠都在这里拒掉；它们没有任何合法用途，只会试探边界。 */
export function workspacePathSegments(input: string): string[] {
  if (input.includes("\0")) throw new WorkspaceError("validation_failed", "路径无效");
  if (input.includes("\\")) throw new WorkspaceError("validation_failed", "路径无效");
  if (input.startsWith("/"))
    throw new WorkspaceError("validation_failed", "路径必须是相对工作区根");
  const segments = input.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments)
    if (segment === "." || segment === "..")
      throw new WorkspaceError("validation_failed", "路径不能包含 . 或 ..");
  return segments;
}

function insideRoot(rootReal: string, candidate: string) {
  return candidate === rootReal || candidate.startsWith(`${rootReal}${sep}`);
}

/**
 * 先按字面量挡一次，再按 realpath 挡一次：字面量检查管 `../`，
 * realpath 检查管符号链接。两次都必须落在根内，缺一不可。
 */
async function resolveInsideRoot(rootReal: string, segments: string[]): Promise<string> {
  const literal = resolvePath(rootReal, ...segments);
  if (!insideRoot(rootReal, literal)) throw new WorkspaceError("forbidden", "路径在工作区之外");
  let real: string;
  try {
    real = await realpath(literal);
  } catch {
    throw new WorkspaceError("not_found", "文件或目录不存在");
  }
  if (!insideRoot(rootReal, real)) throw new WorkspaceError("forbidden", "路径在工作区之外");
  return real;
}

async function openRoot(root: ActiveWorkspaceRoot): Promise<string> {
  try {
    return await realpath(root.path);
  } catch {
    throw new WorkspaceError("not_found", "工作区尚未创建");
  }
}

function toIso(value: Date) {
  return value.toISOString();
}

async function describeEntry(
  directory: string,
  parentSegments: string[],
  dirent: { name: string; isSymbolicLink(): boolean; isDirectory(): boolean },
): Promise<WorkspaceEntry | undefined> {
  const absolute = resolvePath(directory, dirent.name);
  const symlink = dirent.isSymbolicLink();
  let targetStat;
  try {
    targetStat = symlink ? await stat(absolute) : await lstat(absolute);
  } catch {
    return undefined;
  }
  const kind = targetStat.isDirectory() ? "directory" : "file";
  return {
    name: dirent.name,
    path: [...parentSegments, dirent.name].join("/"),
    kind,
    ...(kind === "file" ? { size: targetStat.size } : {}),
    modifiedAt: toIso(targetStat.mtime),
    symlink,
    ...(kind === "file" ? { previewKind: workspacePreviewKind(dirent.name) } : {}),
  };
}

export async function listWorkspaceTree(
  root: ActiveWorkspaceRoot,
  relativePath: string,
): Promise<WorkspaceTree> {
  const rootReal = await openRoot(root);
  const segments = workspacePathSegments(relativePath);
  const directory = await resolveInsideRoot(rootReal, segments);
  const dirents = await readdir(directory, { withFileTypes: true });
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    const entry = await describeEntry(directory, segments, dirent);
    if (!entry) continue;
    if (entry.symlink) {
      const target = await realpath(resolvePath(directory, entry.name)).catch(() => undefined);
      if (!target || !insideRoot(rootReal, target)) continue;
    }
    entries.push(entry);
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-Hans", { numeric: true, sensitivity: "base" });
  });
  return {
    root: root.kind,
    path: segments.join("/"),
    entries: entries.slice(0, WORKSPACE_TREE_MAX_ENTRIES),
    truncated: entries.length > WORKSPACE_TREE_MAX_ENTRIES,
  };
}

export type WorkspaceFile = {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly contentType: string;
  readonly previewKind: WorkspacePreviewKind;
  readonly body: ReadableStream<Uint8Array>;
  /** 本次响应实际回多少字节；206 时不是整个文件大小，Content-Length 必须按它写。 */
  readonly length: number;
  /** 206 表示只回了请求的那一段；响应必须带 Content-Range，否则播放器不会 seek。 */
  readonly status: 200 | 206;
  readonly contentRange?: string;
};

type ByteRange = { readonly start: number; readonly end: number };

function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "") {
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return "unsatisfiable";
    return { start: Math.max(size - length, 0), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

export class WorkspaceRangeError extends WorkspaceError {
  constructor(readonly totalSize: number) {
    super("validation_failed", "请求的字节区间不可满足");
  }
}

/**
 * 打开再核对一次 inode：realpath 与 open 之间目标可能被换成指向根外的链接。
 * O_NOFOLLOW 挡住叶节点本身是链接的情形，dev/ino 比对挡住同一位置被替换的情形。
 */
export async function openWorkspaceFile(
  root: ActiveWorkspaceRoot,
  relativePath: string,
  rangeHeader: string | null,
): Promise<WorkspaceFile> {
  const rootReal = await openRoot(root);
  const segments = workspacePathSegments(relativePath);
  if (segments.length === 0) throw new WorkspaceError("validation_failed", "缺少文件路径");
  const target = await resolveInsideRoot(rootReal, segments);
  const before = await stat(target);
  if (!before.isFile()) throw new WorkspaceError("validation_failed", "目标不是文件");
  const name = segments[segments.length - 1] ?? "";
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino)
      throw new WorkspaceError("forbidden", "文件在读取前被替换");
    const size = after.size;
    const range = parseRange(rangeHeader, size);
    if (range === "unsatisfiable") throw new WorkspaceRangeError(size);
    const body = handle.createReadStream({
      start: range?.start,
      end: range?.end,
      autoClose: true,
    });
    return {
      name,
      size,
      modifiedAt: toIso(after.mtime),
      contentType: workspaceContentType(name),
      previewKind: workspacePreviewKind(name),
      body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
      length: (range?.end ?? size - 1) - (range?.start ?? 0) + 1,
      status: range ? 206 : 200,
      ...(range ? { contentRange: `bytes ${range.start}-${range.end}/${size}` } : {}),
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
