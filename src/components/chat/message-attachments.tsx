import { FileText, ImageOff, Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../../contracts/attachment";
import type { MessageAttachmentSpan } from "../../contracts/chat";
import type { AppResult } from "../../contracts/result";
import { Icon } from "../ui/icon";
import "./message-attachments.css";

/**
 * 消息里的附件呈现，按 operator 选定的「方案 A 紧凑内联」：
 * 引用 span 就地渲染成小芯片，图片与文件在正文之后成组，未在正文引用的附件也照常出现。
 * 字节一律走读取路由（按 session 与 Project 鉴权），消息列表的载荷只带元数据。
 *
 * 字节用 fetch 取回再转 object URL，而不是让 <img> 直接指向路由：dev server 把
 * Sec-Fetch-Dest: image 的请求交给静态资源中间件、不進应用路由（回 Cannot GET），
 * 而 fetch 的 Sec-Fetch-Dest 是 empty，dev 与生产行为一致。
 */
export function attachmentUrl(attachmentId: string): string {
  return "/api/attachments/" + encodeURIComponent(attachmentId);
}

type AttachmentBytes = { url: string } | { failure: string };

/** 读取失败时把服务端给的 app 错误原文带出来，页面上就不是一句笼统的「加载失败」。 */
async function failureMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as AppResult<unknown>;
    return payload.ok ? "附件读取失败" : payload.error.message;
  } catch {
    return "附件读取失败";
  }
}

async function fetchAttachmentBytes(attachmentId: string): Promise<AttachmentBytes> {
  try {
    const response = await fetch(attachmentUrl(attachmentId), { credentials: "same-origin" });
    if (!response.ok) return { failure: await failureMessage(response) };
    return { url: URL.createObjectURL(await response.blob()) };
  } catch {
    return { failure: "附件读取失败" };
  }
}

/** 点芯片直接查看：先同步开窗保住用户手势，再把 blob 地址挂上去，否则会被弹窗拦截。 */
async function openAttachment(attachmentId: string): Promise<void> {
  const opened = window.open("", "_blank");
  if (opened !== null) opened.opener = null;
  const bytes = await fetchAttachmentBytes(attachmentId);
  if (!("url" in bytes) || opened === null) {
    opened?.close();
    return;
  }
  opened.location.href = bytes.url;
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
      onClick={(event) => {
        event.preventDefault();
        void openAttachment(attachment.id);
      }}
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
 * 图片在正文之后成块。字节在滚到附近时才取，取不到就把读取路由给的原因写进占位，
 * 于是「磁盘上的字节没了」与「id 不存在」在页面上是两句话，而不是一张破图。
 */
export function AttachmentFigure({ attachment }: { attachment: Attachment }) {
  const figureRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [bytes, setBytes] = useState<AttachmentBytes | null>(null);

  useEffect(() => {
    const node = figureRef.current;
    if (node === null || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let created: string | null = null;
    void fetchAttachmentBytes(attachment.id).then((result) => {
      if (cancelled) {
        if ("url" in result) URL.revokeObjectURL(result.url);
        return;
      }
      if ("url" in result) created = result.url;
      setBytes(result);
    });
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [attachment.id, visible]);

  if (bytes !== null && "failure" in bytes) {
    return (
      <AttachmentBroken
        attachment={attachment}
        reason={bytes.failure}
        testId="message-attachment-image-broken"
      />
    );
  }
  return (
    <figure
      ref={figureRef}
      className="message-attachment-figure"
      data-testid="message-attachment-figure"
      data-attachment-id={attachment.id}
    >
      {bytes !== null ? (
        <img
          src={bytes.url}
          alt={attachment.filename}
          loading="lazy"
          decoding="async"
          data-testid="message-attachment-image"
        />
      ) : (
        <span className="message-attachment-figure__pending" aria-hidden="true" />
      )}
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
      onClick={(event) => {
        event.preventDefault();
        void openAttachment(attachment.id);
      }}
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
