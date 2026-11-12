import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_MAX_TOTAL_BYTES,
  attachmentToken,
  scanAttachmentTokens,
  type Attachment,
  type NewAttachment,
} from "../contracts/attachment";
import type { MessageAttachmentSpan } from "../contracts/chat";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { db } from "../db";
import { attachment, chat } from "../db/schema";
import { config } from "../lib/config";
import { assertProjectAccess, type ProjectContext } from "./access";

/**
 * 附件错误只用已登记的错误码：这一层不发明新码，`validation_failed` 覆盖超限、空文件与
 * 「正文引用了这次没提交的附件」，具体原因写在消息里。
 */
export class AttachmentError extends Error {
  constructor(
    readonly code: "validation_failed" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

/**
 * 字节落盘的位置跟着库走：`<DATABASE_URL 同目录>/attachments`。测试用临时库时目录也临时，
 * 不需要再配一个环境变量。内存库没有目录可言，退到系统临时目录。
 */
export function attachmentRoot(): string {
  const url = config.DATABASE_URL;
  if (url === ":memory:" || url.startsWith("file::memory:"))
    return join(tmpdir(), "sprout-mio-attachments-memory");
  return join(dirname(resolve(url)), "attachments");
}

/** 磁盘文件名一律用附件 id，不沿用上传原名：原名可能是 `../../x` 这种路径。 */
export function attachmentPath(id: string): string {
  const root = attachmentRoot();
  const path = join(root, id);
  if (!path.startsWith(root + sep)) throw new AttachmentError("not_found", "附件不存在");
  return path;
}

/** 上传原名只用于展示：去掉目录部分与控制字符，并限长。 */
export function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return cleaned.length === 0 ? "附件" : cleaned;
}

/** 上限在写盘之前判完：超限的请求不落任何字节。 */
export function validateNewAttachments(list: readonly NewAttachment[]): void {
  if (list.length > ATTACHMENT_MAX_PER_MESSAGE)
    throw new AttachmentError(
      "validation_failed",
      `一条消息最多带 ${ATTACHMENT_MAX_PER_MESSAGE} 个附件`,
    );
  let total = 0;
  for (const item of list) {
    if (item.bytes.byteLength === 0)
      throw new AttachmentError("validation_failed", `附件 ${item.filename} 是空文件`);
    if (item.bytes.byteLength > ATTACHMENT_MAX_BYTES)
      throw new AttachmentError(
        "validation_failed",
        `附件 ${item.filename} 超过单个上限 ${ATTACHMENT_MAX_BYTES} 字节`,
      );
    total += item.bytes.byteLength;
  }
  if (total > ATTACHMENT_MAX_TOTAL_BYTES)
    throw new AttachmentError(
      "validation_failed",
      `附件总量超过上限 ${ATTACHMENT_MAX_TOTAL_BYTES} 字节`,
    );
}

/** 真实 id 要在正文替换之前定下来，所以先生成再插行。 */
export function allocateAttachmentIds(
  list: readonly NewAttachment[],
): ReadonlyMap<string, string> {
  return new Map(list.map((item) => [item.localId, newId(ID_PREFIXES.attachment)] as const));
}

/**
 * 正文里的本地 id token 换成真实 id，并算出每段在最终正文里的位置。
 * 正文与 `message_attachment` 的 span 从此一一对应，渲染与投递都按 span 定位。
 */
export function rewriteAttachmentTokens(
  body: string,
  idByLocalId: ReadonlyMap<string, string>,
): { body: string; spans: readonly MessageAttachmentSpan[] } {
  const hits = scanAttachmentTokens(body);
  if (hits.length === 0) return { body, spans: [] };
  const spans: MessageAttachmentSpan[] = [];
  let out = "";
  let cursor = 0;
  for (const hit of hits) {
    const id = idByLocalId.get(hit.localId);
    if (id === undefined)
      throw new AttachmentError("validation_failed", "正文引用了这次没有提交的附件");
    const token = attachmentToken(id);
    out += body.slice(cursor, hit.start) + token;
    spans.push({ attachmentId: id, start: out.length - token.length, end: out.length });
    cursor = hit.end;
  }
  out += body.slice(cursor);
  return { body: out, spans };
}

export function toAttachment(row: typeof attachment.$inferSelect): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 附件行与消息行在同一个事务里落库，`messageId` 非空，没有「传了文件但没发消息」的中间态。 */
export function insertAttachments(input: {
  readonly chatId: string;
  readonly messageId: string;
  readonly createdBy: string;
  readonly list: readonly NewAttachment[];
  readonly idByLocalId: ReadonlyMap<string, string>;
}): readonly Attachment[] {
  if (input.list.length === 0) return [];
  return db
    .insert(attachment)
    .values(
      input.list.map((item) => ({
        id: input.idByLocalId.get(item.localId)!,
        chatId: input.chatId,
        messageId: input.messageId,
        filename: sanitizeAttachmentFilename(item.filename),
        mimeType: item.mimeType.length === 0 ? "application/octet-stream" : item.mimeType,
        byteSize: item.bytes.byteLength,
        createdBy: input.createdBy,
      })),
    )
    .returning()
    .all()
    .map(toAttachment);
}

/** 字节在事务里写入；事务回滚时调用方按返回的路径删掉，不留没有行指向的文件。 */
export function writeAttachmentBytes(input: {
  readonly list: readonly NewAttachment[];
  readonly idByLocalId: ReadonlyMap<string, string>;
}): readonly string[] {
  if (input.list.length === 0) return [];
  mkdirSync(attachmentRoot(), { recursive: true });
  const written: string[] = [];
  for (const item of input.list) {
    const path = attachmentPath(input.idByLocalId.get(item.localId)!);
    writeFileSync(path, item.bytes);
    written.push(path);
  }
  return written;
}

/** 回滚清理是尽力而为：文件本来就没写成功时不再报错掩盖原始失败。 */
export function discardAttachmentFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // 忽略：这个文件不存在或已经删过。
    }
  }
}

/** 读取路由的入口：附件归属的 Project 必须属于当前会话，否则按不存在处理。 */
export function readAttachmentForRequest(
  attachmentId: string,
  ctx: ProjectContext,
): Readonly<{ record: Attachment; path: string }> {
  const row = db
    .select({ record: attachment, projectId: chat.projectId })
    .from(attachment)
    .innerJoin(chat, eq(chat.id, attachment.chatId))
    .where(eq(attachment.id, attachmentId))
    .get();
  if (!row) throw new AttachmentError("not_found", "附件不存在");
  assertProjectAccess(ctx, row.projectId);
  return { record: toAttachment(row.record), path: attachmentPath(row.record.id) };
}

/** 磁盘文件被删、被裁掉时给一个明确的错误，而不是未捕获的读盘异常。 */
export function readAttachmentBytes(path: string): Uint8Array<ArrayBuffer> {
  try {
    // 复制成自己的 ArrayBuffer：路由直接把它交给 Response，不留 Buffer 池里的共享底层存储。
    return new Uint8Array(readFileSync(path));
  } catch {
    throw new AttachmentError("not_found", "附件的字节已不在磁盘上");
  }
}
