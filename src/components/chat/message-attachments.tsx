import { FileText, ImageOff, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../../contracts/attachment";
import type { MessageAttachmentSpan } from "../../contracts/chat";
import type { AppResult } from "../../contracts/result";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { ATTACHMENT_MAX_HEIGHT_RATIO, attachmentDisplayWidth } from "./message-attachment-layout";
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

type AttachmentPreview = { url: string; naturalWidth: number; naturalHeight: number };

/** 解码一次拿到原始尺寸，后面按比例决定显示宽度；解不出来就退回按容器宽度显示。 */
async function loadAttachmentPreview(
  attachmentId: string,
): Promise<AttachmentPreview | { failure: string }> {
  const bytes = await fetchAttachmentBytes(attachmentId);
  if ("failure" in bytes) return bytes;
  const image = new Image();
  image.src = bytes.url;
  try {
    await image.decode();
    return {
      url: bytes.url,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  } catch {
    return { url: bytes.url, naturalWidth: 0, naturalHeight: 0 };
  }
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
  const [preview, setPreview] = useState<AttachmentPreview | { failure: string } | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [frame, setFrame] = useState({ width: 0, maxHeight: 0 });

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
    void loadAttachmentPreview(attachment.id).then((result) => {
      if (cancelled) {
        if ("url" in result) URL.revokeObjectURL(result.url);
        return;
      }
      if ("url" in result) created = result.url;
      setPreview(result);
    });
    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [attachment.id, visible]);

  useEffect(() => {
    const node = figureRef.current;
    if (node === null) return;
    const measure = () => {
      const next = {
        width: Math.round(node.getBoundingClientRect().width),
        maxHeight: Math.round(window.innerHeight * ATTACHMENT_MAX_HEIGHT_RATIO),
      };
      setFrame((previous) =>
        previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  if (preview !== null && "failure" in preview) {
    return (
      <AttachmentBroken
        attachment={attachment}
        reason={preview.failure}
        testId="message-attachment-image-broken"
      />
    );
  }
  const width =
    preview === null
      ? undefined
      : attachmentDisplayWidth(
          preview.naturalWidth,
          preview.naturalHeight,
          frame.width,
          frame.maxHeight,
        );
  return (
    <figure
      ref={figureRef}
      className="message-attachment-figure"
      data-testid="message-attachment-figure"
      data-attachment-id={attachment.id}
    >
      {preview !== null ? (
        <button
          type="button"
          className="message-attachment-figure__open"
          data-testid="message-attachment-open"
          aria-label={`查看大图 ${attachment.filename}`}
          title="点击查看大图"
          onClick={() => setViewerOpen(true)}
        >
          <img
            src={preview.url}
            alt={attachment.filename}
            width={width === undefined ? undefined : Math.round(width)}
            loading="lazy"
            decoding="async"
            data-testid="message-attachment-image"
          />
        </button>
      ) : (
        <span className="message-attachment-figure__pending" aria-hidden="true" />
      )}
      <figcaption>
        {attachment.filename} · {formatAttachmentSize(attachment.byteSize)}
      </figcaption>
      {preview !== null && (
        <AttachmentViewer
          attachment={attachment}
          url={preview.url}
          open={viewerOpen}
          onOpenChange={setViewerOpen}
        />
      )}
    </figure>
  );
}

const VIEWER_MIN_SCALE = 1;
const VIEWER_MAX_SCALE = 8;
const VIEWER_WHEEL_STEP = 1.12;

/**
 * 点图片打开的大图窗口。滚轮缩放，缩放超过原始比例才能拖动，双击或「适应窗口」回到原始比例；
 * Escape、点遮罩与关页焦点回到触发处都由 Dialog 提供。
 */
export function AttachmentViewer({
  attachment,
  url,
  open,
  onOpenChange,
}: {
  attachment: Attachment;
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; fromX: number; fromY: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const reset = useCallback(() => {
    setScale(1);
    setOffset((previous) => (previous.x === 0 && previous.y === 0 ? previous : { x: 0, y: 0 }));
  }, []);

  useEffect(() => {
    if (open) reset();
  }, [open, attachment.id, reset]);

  useEffect(() => {
    if (scale > VIEWER_MIN_SCALE) return;
    setOffset((previous) => (previous.x === 0 && previous.y === 0 ? previous : { x: 0, y: 0 }));
  }, [scale]);

  useEffect(() => {
    if (!open || stage === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const step = event.deltaY < 0 ? VIEWER_WHEEL_STEP : 1 / VIEWER_WHEEL_STEP;
      setScale((current) => Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, current * step)));
    };
    // 滚轮监听必须自己装，因为要 preventDefault，React 的 onWheel 在根上是 passive 的。
    // 依赖 stage：Dialog 的门户在 open 之后才挂上，节点晚一步出现。
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [open, stage]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="message-attachment-viewer"
        className="message-viewer w-[94vw] max-w-none gap-0 rounded-none border-0 bg-transparent p-0 max-h-none"
      >
        <div
          ref={setStage}
          className="message-viewer__stage"
          data-testid="message-viewer-stage"
          data-scale={scale.toFixed(2)}
          onDoubleClick={reset}
          onPointerDown={(event) => {
            if (scale <= VIEWER_MIN_SCALE) return;
            dragRef.current = {
              x: event.clientX,
              y: event.clientY,
              fromX: offset.x,
              fromY: offset.y,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const dragging = dragRef.current;
            if (dragging === null) return;
            setOffset({
              x: dragging.fromX + (event.clientX - dragging.x),
              y: dragging.fromY + (event.clientY - dragging.y),
            });
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
        >
          <img
            className="message-viewer__image"
            src={url}
            alt={attachment.filename}
            draggable={false}
            data-testid="message-viewer-image"
            style={{
              transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
            }}
          />
        </div>
        <div className="message-viewer__bar">
          <span className="message-viewer__name">{attachment.filename}</span>
          <span className="message-viewer__zoom" data-testid="message-viewer-zoom">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="secondary" size="sm" onClick={reset}>
            适应窗口
          </Button>
          <DialogClose render={<Button variant="ghost" size="icon-sm" />}>
            <Icon as={X} />
            <span className="sr-only">关闭大图</span>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
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
