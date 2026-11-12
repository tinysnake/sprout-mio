import { FileText, X } from "lucide-react";
import { Icon } from "../ui/icon";

/** 输入区里的待发附件：`url` 是本地 object URL，只用于预览，不随消息发出去。 */
export type ComposerAttachment = Readonly<{ localId: string; file: File; url: string }>;

/** 附件大小按人能读的档位显示；字节数不进正文，只在附件条上露。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 输入框上方的附件条：一行一项，横向滚动，默认不撑高输入区。
 * 每项是能点开查看的 tag：缩略图或文件图标、文件名（截断）、大小；
 * 右上角 `×` 移除，右下角「标签」在光标处插一条对该附件的引用。
 */
export function AttachmentBar({
  attachments,
  onRemove,
  onInsertReference,
  onOpen,
}: {
  attachments: readonly ComposerAttachment[];
  onRemove: (localId: string) => void;
  onInsertReference: (localId: string) => void;
  onOpen: (localId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div
      role="list"
      aria-label="待发送附件"
      data-testid="attachment-bar"
      className="mb-1.5 flex items-stretch gap-1.5 overflow-x-auto pb-0.5"
    >
      {attachments.map(({ localId, file, url }) => (
        <div
          key={localId}
          role="listitem"
          data-testid="attachment-item"
          data-local-id={localId}
          className="relative flex w-52 shrink-0 items-center gap-2 rounded-lg border border-border bg-card py-1.5 pr-7 pl-1.5"
        >
          <button
            type="button"
            // 按下不抢输入框焦点：移除与插引用都按"光标还留在原处"处理。
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onOpen(localId)}
            aria-label={`查看附件 ${file.name}`}
            className="shrink-0 rounded-control outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {file.type.startsWith("image/") ? (
              <img
                src={url}
                alt=""
                className="size-8 rounded-control border border-border object-cover"
              />
            ) : (
              <span className="grid size-8 place-items-center rounded-control bg-secondary text-muted-foreground">
                <Icon as={FileText} />
              </span>
            )}
          </button>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[11px] text-foreground" title={file.name}>
              {file.name}
            </span>
            <span className="text-[10px] text-muted-foreground">{formatSize(file.size)}</span>
          </span>
          <span className="absolute inset-y-1.5 right-1.5 flex flex-col items-end justify-between gap-1">
            <button
              type="button"
              data-testid="attachment-remove"
              aria-label={`移除附件 ${file.name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRemove(localId)}
              className="grid size-5 place-items-center rounded-control text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Icon as={X} size={12} />
            </button>
            <button
              type="button"
              data-testid="attachment-tag"
              aria-label={`在光标处插入附件 ${file.name} 的引用`}
              title="在光标处插入引用"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onInsertReference(localId)}
              className="h-5 rounded-control border border-border px-1.5 text-[10px] leading-none text-muted-foreground outline-none hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              标签
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
