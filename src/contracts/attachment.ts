import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";

/**
 * 上限写成显式常量并落进契约：服务端校验与客户端预检读同一份数字，不在两处各写一遍。
 * 单条消息的数量与总量是两条独立的闸门，任一条超了都拒。
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_MESSAGE = 10;
export const ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export const attachmentIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.attachment));
export type AttachmentId = z.infer<typeof attachmentIdSchema>;

/** 附件元数据：字节不进契约、不进消息载荷，只按 id 走鉴权路由读。 */
export const attachmentSchema = z.object({
  id: attachmentIdSchema,
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * 正文里的附件引用 token。发送是一次提交，客户端手里只有本地 id（服务端 id 还不存在），
 * 服务端落库时把本地 id 换成真实 attachment id，正文与 `message_attachment` 的 span 从此一一对应。
 */
export const ATTACHMENT_LOCAL_ID_SOURCE = "[A-Za-z0-9_-]{1,64}";
const ATTACHMENT_TOKEN_PATTERN = new RegExp(
  `\\[\\[att:(${ATTACHMENT_LOCAL_ID_SOURCE})\\]\\]`,
  "g",
);

export function attachmentToken(id: string): string {
  return `[[att:${id}]]`;
}

export type AttachmentTokenHit = Readonly<{ localId: string; start: number; end: number }>;

export function scanAttachmentTokens(body: string): readonly AttachmentTokenHit[] {
  const hits: AttachmentTokenHit[] = [];
  for (const match of body.matchAll(ATTACHMENT_TOKEN_PATTERN)) {
    const start = match.index;
    if (start === undefined) continue;
    hits.push({ localId: match[1], start, end: start + match[0].length });
  }
  return hits;
}

/** 已上传、尚未落库的附件：`localId` 只用于把正文 token 与文件对上，落库后换成真实 id。 */
export type NewAttachment = Readonly<{
  localId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}>;
