import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { machineIdSchema } from "./machine";
import { workspaceEntrySchema } from "./workspace";

/** 单帧最多的浏览命令数：目录树点击是突发操作，但一帧里塞太多会挤掉执行事实。 */
export const MACHINE_BROWSE_MAX_COMMANDS = 8;
/** 单块原始字节上限；base64 之后约 683 KiB，给同一帧里的其它字段留出余量。 */
export const MACHINE_BROWSE_CHUNK_BYTES = 512 * 1024;
/** 单个 HTTP 请求最多向后端取的字节数；超过直接 413，不靠流式读取硬撑。 */
export const MACHINE_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** 目录单层条目上限；与工作区浏览保持一致，超出标记 truncated。 */
export const MACHINE_BROWSE_MAX_ENTRIES = 2000;
/** 路由等待 worker 回应的上限；浏览是只读的，超时让页面重试比无限等更可预期。 */
export const MACHINE_BROWSE_TIMEOUT_MS = 5000;

export const MACHINE_BROWSE_FAILURE_CODES = [
  "not_found",
  "forbidden",
  "validation_failed",
  "busy",
] as const;
export type MachineBrowseFailureCode = (typeof MACHINE_BROWSE_FAILURE_CODES)[number];

const projectIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.project));
const requestIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.request));

/**
 * 协议只接受根目录内的相对路径。真正的围栏在 worker 上（realpath 之后核对仍在根内），
 * 这里先拒绝一切能改变解析位置的写法，让明显非法的请求不必占用一次往返。
 */
export const machineBrowseCommandSchema = z.strictObject({
  requestId: requestIdSchema,
  projectId: projectIdSchema,
  machineId: machineIdSchema,
  op: z.enum(["dir_list", "file_chunk"]),
  path: z.string().max(4096),
  offset: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().max(MACHINE_BROWSE_CHUNK_BYTES).optional(),
});
export type MachineBrowseCommand = z.infer<typeof machineBrowseCommandSchema>;

export const machineBrowseCommandListSchema = z
  .array(machineBrowseCommandSchema)
  .max(MACHINE_BROWSE_MAX_COMMANDS);

export const machineBrowseEntrySchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.iso.datetime().optional(),
  symlink: z.boolean(),
});
export type MachineBrowseEntry = z.infer<typeof machineBrowseEntrySchema>;

const browseFailure = z.strictObject({
  requestId: requestIdSchema,
  ok: z.literal(false),
  code: z.enum(MACHINE_BROWSE_FAILURE_CODES),
  message: z.string().max(300),
});

export const machineBrowseResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    requestId: requestIdSchema,
    ok: z.literal(true),
    op: z.literal("dir_list"),
    path: z.string(),
    realPath: z.string().min(1),
    entries: z.array(machineBrowseEntrySchema).max(MACHINE_BROWSE_MAX_ENTRIES),
    truncated: z.boolean(),
  }),
  z.strictObject({
    requestId: requestIdSchema,
    ok: z.literal(true),
    op: z.literal("file_chunk"),
    path: z.string(),
    realPath: z.string().min(1),
    totalSize: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
    base64: z.string(),
    eof: z.boolean(),
  }),
  browseFailure,
]);
export type MachineBrowseResult = z.infer<typeof machineBrowseResultSchema>;
export type MachineBrowseDirListResult = Extract<MachineBrowseResult, { ok: true; op: "dir_list" }>;
export type MachineBrowseFileChunkResult = Extract<
  MachineBrowseResult,
  { ok: true; op: "file_chunk" }
>;
export type MachineBrowseFailureResult = z.infer<typeof browseFailure>;

export const machineBrowseResultListSchema = z
  .array(machineBrowseResultSchema)
  .max(MACHINE_BROWSE_MAX_COMMANDS);

export const machineBrowseInput = z.strictObject({
  projectId: projectIdSchema,
  machineId: machineIdSchema,
  path: z.string().max(4096).default(""),
});
export type MachineBrowseInput = z.infer<typeof machineBrowseInput>;

export const machineFileInput = machineBrowseInput;
export type MachineFileInput = z.infer<typeof machineFileInput>;

/**
 * 列表回包与工作区版同形，前端复用同一套条目渲染；路由再加 `root: "machine"`，
 * 用来区分「server 本机工作区」和「远端机器」两个来源。
 */
export const machineTreeSchema = z.object({
  machineId: machineIdSchema,
  machineName: z.string().min(1),
  rootDirectory: z.string().min(1),
  path: z.string(),
  entries: z.array(workspaceEntrySchema),
  truncated: z.boolean(),
});
export type MachineTree = z.infer<typeof machineTreeSchema>;
