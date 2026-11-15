import { and, eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  MACHINE_BROWSE_CHUNK_BYTES,
  MACHINE_BROWSE_MAX_COMMANDS,
  MACHINE_BROWSE_TIMEOUT_MS,
  MACHINE_FILE_MAX_BYTES,
  machineBrowseCommandSchema,
  type MachineBrowseCommand,
  type MachineBrowseDirListResult,
  type MachineBrowseFileChunkResult,
  type MachineBrowseFailureResult,
  type MachineBrowseInput,
  type MachineBrowseResult,
  type MachineTree,
} from "../contracts/machine-browse";
import { workspaceEntrySchema, type WorkspaceEntry } from "../contracts/workspace";
import { WORKER_STALE_AFTER_MS } from "../contracts/worker";
import { db } from "../db";
import {
  directoryObservation,
  machine,
  machineConnection,
  machineConnectionCounter,
  projectMachine,
} from "../db/schema";
import { assertProjectAccess } from "../domain/access";
import type { ProjectContext } from "../domain/project";
import { workspaceContentType, workspacePreviewKind } from "../lib/workspace-preview";
import { membershipActive } from "./membership";

export type MachineBrowseContext = ProjectContext & { readonly bootId: string; readonly now: Date };

export type MachineBrowseErrorCode = "forbidden" | "not_found" | "validation_failed" | "conflict";

export class MachineBrowseError extends Error {
  constructor(
    readonly code: MachineBrowseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MachineBrowseError";
  }
}

export class MachineRangeError extends Error {
  constructor(readonly totalSize: number) {
    super("请求的字节区间不可满足");
    this.name = "MachineRangeError";
  }
}

export class MachineFileTooLargeError extends Error {
  constructor(readonly totalSize: number) {
    super(`单次最多读取 ${MACHINE_FILE_MAX_BYTES} 字节，请用 Range 分段`);
    this.name = "MachineFileTooLargeError";
  }
}

export type BrowseTarget = {
  readonly projectId: string;
  readonly machineId: string;
  readonly machineName: string;
  readonly rootDirectory: string;
  readonly generation: number;
};

/**
 * 读权限与租约分离：审核发生在 agent 结束之后，此时没有租约、没有 run、没有 instance。
 * 这里只核对 Project 归属、绑定关系与机器是否在线，不碰 `remote_execution`。
 */
export function resolveBrowseTarget(
  projectId: string,
  machineId: string,
  ctx: MachineBrowseContext,
): BrowseTarget {
  assertProjectAccess({ userId: ctx.userId, requestId: ctx.requestId }, projectId);
  const binding = db
    .select()
    .from(projectMachine)
    .where(and(eq(projectMachine.projectId, projectId), eq(projectMachine.machineId, machineId)))
    .get();
  if (!binding) throw new MachineBrowseError("not_found", "这台 Machine 没有绑定到该 Project");
  if (!membershipActive(projectId, machineId))
    throw new MachineBrowseError("not_found", "这台 Machine 已从该 Project 移出");
  const row = db.select().from(machine).where(eq(machine.id, machineId)).get();
  if (!row) throw new MachineBrowseError("not_found", "机器不存在");
  if (row.rootDirectory === null)
    throw new MachineBrowseError("conflict", "这台 Machine 还没有设置根目录");
  const counter = db
    .select()
    .from(machineConnectionCounter)
    .where(eq(machineConnectionCounter.machineId, machineId))
    .get();
  const connection = counter
    ? db
        .select()
        .from(machineConnection)
        .where(
          and(
            eq(machineConnection.machineId, machineId),
            eq(machineConnection.generation, counter.highWater),
          ),
        )
        .get()
    : undefined;
  if (
    !counter ||
    counter.highWater === 0 ||
    !connection ||
    connection.status !== "open" ||
    connection.bootId !== ctx.bootId ||
    ctx.now.getTime() - connection.lastSeenAt.getTime() >= WORKER_STALE_AFTER_MS
  )
    throw new MachineBrowseError("conflict", "机器不在线");
  const observation = db
    .select()
    .from(directoryObservation)
    .where(
      and(
        eq(directoryObservation.machineId, machineId),
        eq(directoryObservation.generation, connection.generation),
        eq(directoryObservation.projectId, projectId),
        eq(directoryObservation.revision, row.rootRevision),
      ),
    )
    .get();
  if (!observation || observation.kind !== "accessible" || !observation.realPath)
    throw new MachineBrowseError("conflict", "机器的项目工作目录当前不可访问");
  return {
    projectId,
    machineId,
    machineName: row.name,
    rootDirectory: row.rootDirectory,
    generation: connection.generation,
  };
}

/**
 * 服务端先拒一次绝对路径/`..`/反斜杠/NUL：真正的围栏在 worker 上，
 * 这里只是让明显非法的请求不必占用一次往返。
 */
export function browseSegments(input: string): string[] {
  if (input.includes("\0")) throw new MachineBrowseError("validation_failed", "路径包含 NUL");
  if (input.includes("\\")) throw new MachineBrowseError("validation_failed", "路径不能包含反斜杠");
  if (input.startsWith("/"))
    throw new MachineBrowseError("validation_failed", "路径必须是相对路径");
  if (input === "") return [];
  const segments = input.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      throw new MachineBrowseError("validation_failed", "路径包含无效段");
  }
  return segments;
}

type PendingBrowse = {
  command: MachineBrowseCommand;
  result?: MachineBrowseResult;
  readonly waiters: Set<(result: MachineBrowseResult) => void>;
  readonly expiresAt: number;
  sentAt: number | null;
};

/** 300 条 / 30s：足以覆盖一次页面里并发的目录与首块请求，又不会把结果无限攒在进程里。 */
const MAX_PENDING_BROWSE = 300;
const BROWSE_TTL_MS = 30_000;
/** 同一请求在途超过这个时间才重发，避免每次 2s 轮询都重复下发。 */
const BROWSE_RESEND_MS = 3_000;

const pendingBrowse = new Map<string, PendingBrowse>();

function fail(
  requestId: string,
  code: "busy" | "not_found" | "forbidden" | "validation_failed",
  message: string,
): MachineBrowseFailureResult {
  return { requestId, ok: false, code, message };
}

function prune(now: number) {
  for (const [requestId, entry] of pendingBrowse) {
    if (entry.expiresAt > now) continue;
    for (const waiter of entry.waiters) waiter(fail(requestId, "busy", "浏览请求已过期"));
    pendingBrowse.delete(requestId);
  }
}

function enqueue(
  target: BrowseTarget,
  op: MachineBrowseCommand["op"],
  path: string,
  now: number,
  options: { offset?: number; maxBytes?: number } = {},
): string {
  prune(now);
  if (pendingBrowse.size >= MAX_PENDING_BROWSE)
    throw new MachineBrowseError("conflict", "浏览请求过多，请稍后再试");
  const requestId = newId(ID_PREFIXES.request);
  const command = machineBrowseCommandSchema.parse({
    requestId,
    projectId: target.projectId,
    machineId: target.machineId,
    op,
    path,
    offset: options.offset,
    maxBytes: options.maxBytes,
  });
  pendingBrowse.set(requestId, {
    command,
    waiters: new Set(),
    expiresAt: now + BROWSE_TTL_MS,
    sentAt: null,
  });
  return requestId;
}

export function awaitBrowse(
  requestId: string,
  timeoutMs = MACHINE_BROWSE_TIMEOUT_MS,
): Promise<MachineBrowseResult> {
  return new Promise((resolve) => {
    const entry = pendingBrowse.get(requestId);
    if (!entry) {
      resolve(fail(requestId, "busy", "浏览请求已过期"));
      return;
    }
    if (entry.result) {
      resolve(entry.result);
      return;
    }
    const waiter = (result: MachineBrowseResult) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      entry.waiters.delete(waiter);
      resolve(fail(requestId, "busy", "机器没有在预期时间内回应"));
    }, timeoutMs);
    entry.waiters.add(waiter);
  });
}

/** 只有仍在等待的请求才下发：路由已超时的请求再读一次盘没有意义。 */
export function takeBrowseCommands(machineId: string, now: number): MachineBrowseCommand[] {
  prune(now);
  const commands: MachineBrowseCommand[] = [];
  for (const entry of pendingBrowse.values()) {
    if (commands.length >= MACHINE_BROWSE_MAX_COMMANDS) break;
    if (entry.command.machineId !== machineId) continue;
    if (entry.result || entry.waiters.size === 0) continue;
    if (entry.sentAt !== null && now - entry.sentAt < BROWSE_RESEND_MS) continue;
    entry.sentAt = now;
    commands.push(entry.command);
  }
  return commands;
}

export function mergeBrowseResults(
  machineId: string,
  results: readonly MachineBrowseResult[],
  now: number,
) {
  prune(now);
  for (const result of results) {
    const entry = pendingBrowse.get(result.requestId);
    if (!entry || entry.command.machineId !== machineId || entry.result) continue;
    entry.result = result;
    for (const waiter of entry.waiters) waiter(result);
    entry.waiters.clear();
    pendingBrowse.delete(result.requestId);
  }
}

export function pendingBrowseCount() {
  return pendingBrowse.size;
}

function workerFailure(result: MachineBrowseResult & { ok: false }): never {
  const code: MachineBrowseErrorCode = result.code === "busy" ? "conflict" : result.code;
  throw new MachineBrowseError(code, result.message);
}

function canonicalPath(segments: readonly string[]): string {
  return segments.join("/");
}

function safeEntryName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

export async function readMachineTree(
  ctx: MachineBrowseContext,
  input: MachineBrowseInput,
): Promise<MachineTree> {
  const target = resolveBrowseTarget(input.projectId, input.machineId, ctx);
  const segments = browseSegments(input.path);
  const now = ctx.now.getTime();
  const requestId = enqueue(target, "dir_list", canonicalPath(segments), now);
  const result = await awaitBrowse(requestId);
  if (!result.ok) workerFailure(result);
  if (result.op !== "dir_list")
    throw new MachineBrowseError("conflict", "机器返回了不匹配的浏览结果");
  const listed: MachineBrowseDirListResult = result;
  const entries: WorkspaceEntry[] = [];
  for (const entry of listed.entries) {
    if (!safeEntryName(entry.name)) continue;
    const entryPath = canonicalPath([...segments, entry.name]);
    entries.push(
      workspaceEntrySchema.parse({
        ...entry,
        path: entryPath,
        ...(entry.kind === "file" ? { previewKind: workspacePreviewKind(entry.name) } : {}),
      }),
    );
  }
  return {
    machineId: target.machineId,
    machineName: target.machineName,
    rootDirectory: target.rootDirectory,
    path: canonicalPath(segments),
    entries,
    truncated: listed.truncated || entries.length < listed.entries.length,
  };
}

export type MachineFileChunk = MachineBrowseFileChunkResult & { readonly requestId: string };

export function decodeBrowseChunk(base64: string): Uint8Array {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > MACHINE_BROWSE_CHUNK_BYTES)
    throw new MachineBrowseError("validation_failed", "浏览块超过单块字节上限");
  return bytes;
}

async function fetchChunk(
  target: BrowseTarget,
  path: string,
  offset: number,
  maxBytes: number,
  now: number,
): Promise<MachineBrowseResult> {
  const requestId = enqueue(target, "file_chunk", path, now, { offset, maxBytes });
  return awaitBrowse(requestId);
}

type ByteRange = { readonly start: number; readonly end: number };

/** 与工作区浏览同一套语义：后缀区间、单段、越界即 unsatisfiable。 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | undefined {
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

function rangeHint(header: string | null): { start: number; end?: number } {
  if (!header) return { start: 0 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || match[1] === "") return { start: 0 };
  const start = Number(match[1]);
  const end = match[2] === "" ? undefined : Number(match[2]);
  return {
    start: Number.isSafeInteger(start) && start >= 0 ? start : 0,
    ...(end !== undefined && Number.isSafeInteger(end) && end >= 0 ? { end } : {}),
  };
}

export type MachineFile = {
  readonly name: string;
  readonly contentType: string;
  readonly previewKind: ReturnType<typeof workspacePreviewKind>;
  readonly machineName: string;
  readonly rootDirectory: string;
  readonly status: 200 | 206;
  readonly length: number;
  readonly totalSize: number;
  readonly contentRange?: string;
  readonly body: ReadableStream<Uint8Array>;
};

export async function openMachineFile(
  ctx: MachineBrowseContext,
  input: MachineBrowseInput,
  rangeHeader: string | null,
): Promise<MachineFile> {
  const target = resolveBrowseTarget(input.projectId, input.machineId, ctx);
  const segments = browseSegments(input.path);
  if (segments.length === 0) throw new MachineBrowseError("validation_failed", "缺少文件路径");
  const path = canonicalPath(segments);
  const now = ctx.now.getTime();
  const hint = rangeHint(rangeHeader);
  const firstMax = hint.end === undefined ? MACHINE_BROWSE_CHUNK_BYTES : hint.end - hint.start + 1;

  let first = await fetchChunk(
    target,
    path,
    hint.start,
    Math.min(MACHINE_BROWSE_CHUNK_BYTES, Math.max(1, firstMax)),
    now,
  );
  if (!first.ok && hint.start > 0) {
    // 起点可能就是越界的：先读 1 字节拿到文件大小，才能按语义回 416 而不是验证失败。
    const probe = await fetchChunk(target, path, 0, 1, now);
    if (!probe.ok) workerFailure(probe);
    if (probe.op !== "file_chunk")
      throw new MachineBrowseError("conflict", "机器返回了不匹配的浏览结果");
    const range = parseByteRange(rangeHeader, probe.totalSize);
    if (range === "unsatisfiable" || range === undefined)
      throw new MachineRangeError(probe.totalSize);
    first = await fetchChunk(target, path, range.start, MACHINE_BROWSE_CHUNK_BYTES, now);
  }
  if (!first.ok) workerFailure(first);
  if (first.op !== "file_chunk")
    throw new MachineBrowseError("conflict", "机器返回了不匹配的浏览结果");

  const totalSize = first.totalSize;
  const range = parseByteRange(rangeHeader, totalSize);
  if (range === "unsatisfiable") throw new MachineRangeError(totalSize);
  const start = range?.start ?? 0;
  const end = range?.end ?? totalSize - 1;
  const length = totalSize === 0 ? 0 : end - start + 1;
  if (length > MACHINE_FILE_MAX_BYTES) throw new MachineFileTooLargeError(length);

  const name = segments[segments.length - 1]!;
  const iterator = fileChunks(target, path, start, end, first, now);
  return {
    name,
    contentType: workspaceContentType(name),
    previewKind: workspacePreviewKind(name),
    machineName: target.machineName,
    rootDirectory: target.rootDirectory,
    status: range ? 206 : 200,
    length,
    totalSize,
    ...(range ? { contentRange: `bytes ${start}-${end}/${totalSize}` } : {}),
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch {
          controller.error(new Error("远端读取中断"));
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    }),
  };
}

async function* fileChunks(
  target: BrowseTarget,
  path: string,
  start: number,
  end: number,
  first: MachineBrowseFileChunkResult,
  now: number,
): AsyncGenerator<Uint8Array> {
  let offset = start;
  let buffered: Uint8Array | null = first.offset === start ? decodeBrowseChunk(first.base64) : null;
  while (offset <= end) {
    let bytes = buffered;
    buffered = null;
    if (!bytes) {
      const wanted = Math.min(MACHINE_BROWSE_CHUNK_BYTES, end - offset + 1);
      const result = await fetchChunk(target, path, offset, wanted, now);
      if (!result.ok) workerFailure(result);
      if (result.op !== "file_chunk")
        throw new MachineBrowseError("conflict", "机器返回了不匹配的浏览结果");
      bytes = decodeBrowseChunk(result.base64);
      if (bytes.byteLength === 0) return;
    }
    const take = Math.min(bytes.byteLength, end - offset + 1);
    yield bytes.subarray(0, take);
    offset += take;
  }
}
