import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";

/**
 * 单层最多回多少条：目录可能很大（依赖树、构建产物），一次全量回会把响应和 DOM 一起压垮。
 * 超出的部分标记 truncated，由界面提示「目录过大」，而不是静默截断。
 */
export const WORKSPACE_TREE_MAX_ENTRIES = 2000;
/** 单次读取的响应字节上限；视频按 Range 分段，不需要一次读全。 */
export const WORKSPACE_FILE_MAX_BYTES = 64 * 1024 * 1024;

const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const chatIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.chat));

/**
 * 预览分流只决定「用哪个渲染器」，不决定安全边界：安全边界一律看真实路径是否在工作区内。
 * binary 是兜底，说明没有可用的内嵌阅读器。
 */
export const workspacePreviewKindSchema = z.enum([
  "markdown",
  "text",
  "code",
  "csv",
  "html",
  "image",
  "video",
  "audio",
  "pdf",
  "binary",
]);
export type WorkspacePreviewKind = z.infer<typeof workspacePreviewKindSchema>;

export const workspaceEntrySchema = z.object({
  name: z.string().min(1),
  /** 相对工作区根，用 `/` 分隔；根自身是空串。 */
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.iso.datetime().optional(),
  /** 符号链接单独标记：解析后仍必须在工作区内，否则读取时按 forbidden 拒绝。 */
  symlink: z.boolean(),
  previewKind: workspacePreviewKindSchema.optional(),
});
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export const workspaceTreeSchema = z.object({
  /** repository 是 Project 的工作副本；workspace 是该 Chat 的 Pi 实例工作目录。 */
  root: z.enum(["repository", "workspace"]),
  path: z.string(),
  entries: z.array(workspaceEntrySchema),
  truncated: z.boolean(),
});
export type WorkspaceTree = z.infer<typeof workspaceTreeSchema>;

export const workspaceTreeInput = z.object({
  projectId,
  chatId: chatIdSchema.optional(),
  path: z.string().default(""),
});
export type WorkspaceTreeInput = z.infer<typeof workspaceTreeInput>;

export const workspaceFileInput = workspaceTreeInput;
export type WorkspaceFileInput = z.infer<typeof workspaceFileInput>;

