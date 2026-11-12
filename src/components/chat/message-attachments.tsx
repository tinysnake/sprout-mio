import { FileText, ImageOff, Paperclip } from "lucide-react";
import { useState } from "react";
import type { Attachment } from "../../contracts/attachment";
import type { MessageAttachmentSpan } from "../../contracts/chat";
import type { AppResult } from "../../contracts/result";
import { Icon } from "../ui/icon";
import "./message-attachments.css";

/**
 * 消息里的附件呈现，按 operator 选定的「方案 A 紧凑内联」：
 * 引用 span 就地渲染成小芯片，图片与文件在正文之后成组，未在正文引用的附件也照常出现。
 * 字节一律走读取路由（按 session 与 Project 鉴权），消息列表的载荷只带元数据。
 */
export function attachmentUrl(attachmentId: string): string {
  return "/api/attachments/" + encodeURIComponent(attachmentId);
}

export function isImageAttachment(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * 正文引用的图片排成图块，其余（非图片附件与未引用的附件）排成一行芯片。
 * 引用顺序取 span 的首次出现顺序，未引用的排在最后。
 */
export function partitionAttachments(
  attachments: readonly Attachment[],
  attachmentSpans: readonly MessageAttachmentSpan[],
): { figures: Attachment[]; chips: Attachment[] } {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const referenced: Attachment[] = [];
  const seen = new Set<string>();
  for (const span of attachmentSpans) {
    if (seen.has(span.attachmentId)) continue;
    seen.add(span.attachmentId);
    const attachment = byId.get(span.attachmentId);
    if (attachment) referenced.push(attachment);
  }
  const rest = attachments.filter((attachment) => !seen.has(attachment.id));
  const ordered = [...referenced, ...rest];
  return {
    figures: ordered.filter((attachment) => isImageAttachment(attachment.mimeType)),
    chips: ordered.filter((attachment) => !isImageAttachment(attachment.mimeType)),
  };
}

/** 正文里对某个附件的引用。 */
export function AttachmentRefChip({ attachment }: { attachment: Attachment }) {
  return (
    <a
      className="message-attachment-ref"
      data-testid="message-attachment-ref"
      data-attachment-id={attachment.id}
      href={attachmentUrl(attachment.id)}
      target="_blank"
      rel="noreferrer"
      title={attachment.filename}
    >
      <Icon as={Paperclip} size={11} />
      <span className="message-attachment-ref__name">{attachment.filename}</span>
    </a>
  );
}

/** 引用指向的那条附件记录不在本条消息里（库里被删或数据不一致），不吞掉引用本身。 */
export function AttachmentMissingRef({ attachmentId }: { attachmentId: string }) {
  return (
    <span
      className="message-attachment-broken"
      data-testid="message-attachment-missing"
      data-attachment-id={attachmentId}
    >
      <Icon as={ImageOff} size={12} />
      <span>
        <strong>附件缺失</strong> {attachmentId}
      </span>
    </span>
  );
}

function AttachmentBroken({
  attachment,
  reason,
  testId,
}: {
  attachment: Attachment;
  reason: string;
  testId: string;
}) {
  return (
    <div
      className="message-attachment-broken"
      data-testid={testId}
      data-attachment-id={attachment.id}
    >
      <Icon as={ImageOff} size={13} />
      <span>
        <strong>{attachment.filename}</strong> {reason}
      </span>
    </div>
  );
}

/**
 * 图片在正文之后成块。加载失败时再问一次读取路由，把它给出的原因写进占位，
 * 于是「磁盘上的字节没了」与「id 不存在」在页面上是两句话，而不是一张破图。
 */
export function AttachmentFigure({ attachment }: { attachment: Attachment }) {
  const [failure, setFailure] = useState<string | null>(null);
  const report = () => {
    setFailure("附件读取失败");
    void (async () => {
      try {
        const response = await fetch(attachmentUrl(attachment.id), { credentials: "same-origin" });
        if (response.ok) return;
        const payload = (await response.json()) as AppResult<unknown>;
        if (!payload.ok) setFailure(payload.error.message);
      } catch {
        // 请求本身失败时保留兜底文案。
      }
    })();
  };
  if (failure !== null) {
    return (
      <AttachmentBroken
        attachment={attachment}
        reason={failure}
        testId="message-attachment-image-broken"
      />
    );
  }
  return (
    <figure
      className="message-attachment-figure"
      data-testid="message-attachment-figure"
      data-attachment-id={attachment.id}
    >
      <img
        src={attachmentUrl(attachment.id)}
        alt={attachment.filename}
        loading="lazy"
        decoding="async"
        onError={report}
      />
      <figcaption>
        {attachment.filename} · {formatAttachmentSize(attachment.byteSize)}
      </figcaption>
    </figure>
  );
}

export function AttachmentFileChip({ attachment }: { attachment: Attachment }) {
  return (
    <a
      className="message-attachment-file"
      data-testid="message-attachment-file"
      data-attachment-id={attachment.id}
      href={attachmentUrl(attachment.id)}
      target="_blank"
      rel="noreferrer"
      title={attachment.filename}
    >
      <span className="message-attachment-file__icon">
        <Icon as={FileText} size={13} />
      </span>
      <span className="message-attachment-file__meta">
        <span className="message-attachment-file__name">{attachment.filename}</span>
        <span className="message-attachment-file__size">
          {formatAttachmentSize(attachment.byteSize)}
        </span>
      </span>
    </a>
  );
}

export function MessageAttachments({
  figures,
  chips,
}: {
  figures: readonly Attachment[];
  chips: readonly Attachment[];
}) {
  if (figures.length === 0 && chips.length === 0) return null;
  return (
    <>
      {figures.length > 0 && (
        <div className="message-attachment-figures" data-testid="message-attachment-figures">
          {figures.map((attachment) => (
            <AttachmentFigure key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div className="message-attachment-files" data-testid="message-attachment-files">
          {chips.map((attachment) => (
            <AttachmentFileChip key={attachment.id} attachment={attachment} />
          ))}
        </div>
      )}
    </>
  );
}
