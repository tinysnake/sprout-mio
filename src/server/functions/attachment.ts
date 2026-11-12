import { z } from "zod";
import {
  ATTACHMENT_MAX_TOTAL_BYTES,
  attachmentIdSchema,
  type NewAttachment,
} from "../../contracts/attachment";
import { chatIdInput, sendMessageInput, type ChatResult, type Message } from "../../contracts/chat";
import { fieldErrorsFrom } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { AppResult } from "../../contracts/result";
import { config } from "../../lib/config";
import { isTrustedOrigin } from "../../lib/origin";
import type { DiagnosticInput } from "../diagnostics";
import { toDomainAppError } from "./domain-errors";

/** multipart 的文本字段与 JSON 请求体同名同规则，客户端与边界不各写一套校验。 */
const attachFields = z.object({
  ...chatIdInput.shape,
  body: sendMessageInput.shape.body,
});

type DiagnosticRecorder = (input: DiagnosticInput) => boolean;

async function failure(
  error: unknown,
  requestId: string,
  recordDiagnostic: DiagnosticRecorder | undefined,
): Promise<ChatResult<never>> {
  const mapped = await toDomainAppError(error, requestId);
  if (mapped) return fail(mapped);
  console.error("[attachment] 请求失败", { requestId, error });
  recordDiagnostic?.({
    level: "error",
    event: "attachment.request_failed",
    requestId,
    message: "附件请求失败",
    data: { code: "internal" },
  });
  return fail({ code: "internal", message: "内部错误", requestId });
}

/**
 * 附件随发送一次提交：同一个 multipart 里带文本字段与文件，服务端在一条事务里落
 * attachment / message / message_attachment，失败整体回滚，所以没有「传了文件没发出去」的孤儿。
 * 这是全库第一处非 server function 的写请求，浏览器不会自动带 Origin 之外的东西，所以
 * 在这里显式校验 Origin，防跨站表单往这个端点塞文件。
 */
export async function uploadMessageAttachmentsBoundary(
  request: Request,
  requestId: string,
): Promise<ChatResult<Message>> {
  let recordDiagnostic: DiagnosticRecorder | undefined;
  try {
    ({ recordDiagnostic } = await import("../diagnostics"));
    if (!isTrustedOrigin(request.headers.get("origin"), config.APP_ORIGIN, config.APP_TRUSTED_ORIGINS))
      return fail({ code: "forbidden", message: "来源未通过校验", requestId });

    // multipart 的体积先按声明判一次，别等把整个 body 读进内存才拒。
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > ATTACHMENT_MAX_TOTAL_BYTES + 256 * 1024)
      return fail({ code: "validation_failed", message: "附件总量超过上限", requestId });

    const [session, chat, attachments] = await Promise.all([
      import("../session"),
      import("../../domain/chat"),
      import("../../domain/attachment"),
    ]);
    const authenticated = await session.requireSession(request.headers, requestId);
    if (!authenticated.ok) return authenticated;

    const form = await request.formData();
    const parsed = attachFields.safeParse({ chatId: form.get("chatId"), body: form.get("body") });
    if (!parsed.success)
      return { ...fail(toAppError(parsed.error, requestId)), fieldErrors: fieldErrorsFrom(parsed.error) };

    const localIds = form.getAll("localIds").map((value) => String(value));
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    if (files.length !== localIds.length)
      return fail({
        code: "validation_failed",
        message: "附件的本地标识与文件数量不一致",
        requestId,
      });

    const list: NewAttachment[] = await Promise.all(
      files.map(async (file, index) => ({
        localId: localIds[index]!,
        filename: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    attachments.validateNewAttachments(list);

    return ok(
      chat.sendMessage(
        parsed.data.chatId,
        { senderKind: "human", senderId: authenticated.data.userId, body: parsed.data.body },
        { userId: authenticated.data.userId, requestId },
        {},
        list,
      ),
      requestId,
    );
  } catch (error) {
    return failure(error, requestId, recordDiagnostic);
  }
}

export type ReadAttachmentResult = {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly filename: string;
  readonly byteSize: number;
};

/** 读取路由按会话与 Project 双重鉴权：不属于当前用户的 Project 一律当作不存在。 */
export async function readAttachmentBoundary(
  attachmentId: string,
  headers: Headers,
  requestId: string,
): Promise<AppResult<ReadAttachmentResult>> {
  try {
    if (!attachmentIdSchema.safeParse(attachmentId).success)
      return fail({ code: "not_found", message: "附件不存在", requestId });
    const [runtime, session, attachments] = await Promise.all([
      import("../runtime"),
      import("../session"),
      import("../../domain/attachment"),
    ]);
    await runtime.runtimeReady;
    const authenticated = await session.requireSession(headers, requestId);
    if (!authenticated.ok) return authenticated;
    const found = attachments.readAttachmentForRequest(attachmentId, {
      userId: authenticated.data.userId,
      requestId,
    });
    return ok(
      {
        bytes: attachments.readAttachmentBytes(found.path),
        contentType: found.record.mimeType,
        filename: found.record.filename,
        byteSize: found.record.byteSize,
      },
      requestId,
    );
  } catch (error) {
    const mapped = await toDomainAppError(error, requestId);
    if (mapped) return fail(mapped);
    console.error("[attachment] 读取失败", { requestId, attachmentId, error });
    return fail({ code: "internal", message: "内部错误", requestId });
  }
}
