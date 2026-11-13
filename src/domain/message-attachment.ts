import { and, asc, eq, inArray } from "drizzle-orm";
import type { Attachment } from "../contracts/attachment";
import type { MessageAttachmentSpan } from "../contracts/chat";
import { db } from "../db";
import { attachment, messageAttachment } from "../db/schema";
import { attachmentPath, toAttachment } from "./attachment";

/** 与 message_skill 同构：引用 span 与消息行同一个事务写入，位置就是正文里 token 的位置。 */
export function writeMessageAttachments(
  chatId: string,
  messageId: string,
  spans: readonly MessageAttachmentSpan[],
): void {
  if (spans.length === 0) return;
  db.insert(messageAttachment)
    .values(spans.map((span) => ({ chatId, messageId, ...span })))
    .run();
}

export function readAttachmentSpansFor(
  chatId: string,
  messageIds: readonly string[],
): ReadonlyMap<string, MessageAttachmentSpan[]> {
  if (messageIds.length === 0) return new Map();
  const rows = db
    .select()
    .from(messageAttachment)
    .where(
      and(
        eq(messageAttachment.chatId, chatId),
        inArray(messageAttachment.messageId, [...messageIds]),
      ),
    )
    .orderBy(asc(messageAttachment.messageId), asc(messageAttachment.start))
    .all();
  const grouped = new Map<string, MessageAttachmentSpan[]>();
  for (const row of rows) {
    const span = { attachmentId: row.attachmentId, start: row.start, end: row.end };

    const list = grouped.get(row.messageId);
    if (list) list.push(span);
    else grouped.set(row.messageId, [span]);
  }
  return grouped;
}

export function readAttachmentsFor(
  chatId: string,
  messageIds: readonly string[],
): ReadonlyMap<string, Attachment[]> {
  if (messageIds.length === 0) return new Map();
  const rows = db
    .select()
    .from(attachment)
    .where(and(eq(attachment.chatId, chatId), inArray(attachment.messageId, [...messageIds])))
    .orderBy(asc(attachment.messageId), asc(attachment.createdAt), asc(attachment.id))
    .all();
  const grouped = new Map<string, Attachment[]>();
  for (const row of rows) {
    const item = toAttachment(row);
    const list = grouped.get(row.messageId);
    if (list) list.push(item);
    else grouped.set(row.messageId, [item]);
  }
  return grouped;
}

/** 附件行没有 span 时（老消息或客户端异常）渲染与投递都要能兜住，按未引用处理。 */
export function unreferencedAttachments(
  attachments: readonly Attachment[],
  spans: readonly MessageAttachmentSpan[],
): readonly Attachment[] {
  const referenced = new Set(spans.map((span) => span.attachmentId));
  return attachments.filter((item) => !referenced.has(item.id));
}

/** 自由文本放最后，前面的字段是空格分隔的键值，便于 Agent 直接读。 */
function describe(item: Attachment): string {
  return `[附件 id=${item.id} type=${item.mimeType} size=${item.byteSize} path=${attachmentPath(item.id)} name="${item.filename}"]`;
}

const ATTACHMENT_SENTINEL = "\u0001ATT\u0001";

function sentinelOfLength(length: number): string {
  return ATTACHMENT_SENTINEL + "\u0001".repeat(Math.max(0, length - ATTACHMENT_SENTINEL.length));
}

/**
 * 技能展开按字符下标定位，先给附件 token 换上等长哨兵，长度不变就不会挪动技能 span。
 * 投递时再把哨兵换回可供 Agent 读的清单文本。
 */
export function maskAttachmentTokens(
  body: string,
  spans: readonly MessageAttachmentSpan[],
): string {
  if (spans.length === 0) return body;
  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(body.slice(cursor, span.start));
    pieces.push(sentinelOfLength(span.end - span.start));
    cursor = span.end;
  }
  pieces.push(body.slice(cursor));
  return pieces.join("");
}

/** 按正文顺序把哨兵换回附件清单；span 顺序与哨兵出现顺序一致。 */
export function unmaskAttachmentTokens(
  text: string,
  spans: readonly MessageAttachmentSpan[],
  byId: ReadonlyMap<string, Attachment>,
): string {
  if (spans.length === 0) return text;
  let out = text;
  for (const span of spans) {
    const sentinel = sentinelOfLength(span.end - span.start);
    const index = out.indexOf(sentinel);
    if (index < 0) continue;
    const item = byId.get(span.attachmentId);
    const replacement = item ? describe(item) : `[附件 id=${span.attachmentId} 已缺失]`;
    out = out.slice(0, index) + replacement + out.slice(index + sentinel.length);
  }
  return out;
}

/** 正文里没被引用的附件也要让 Agent 知道存在，附在投递文本末尾。 */
export function unreferencedAttachmentLines(
  attachments: readonly Attachment[],
  spans: readonly MessageAttachmentSpan[],
): string {
  const missing = unreferencedAttachments(attachments, spans);
  if (missing.length === 0) return "";
  return `\n\n（本条消息还带了未在正文引用的附件）\n${missing.map(describe).join("\n")}`;
}
