import { MessageSquare, X } from "lucide-react";
import { useChatFile } from "../chat/chat-search";
import { Icon } from "../ui/icon";
import { workspaceFileUrl } from "./workspace-api";
import { WorkspacePreview } from "./workspace-preview";

/**
 * 中栏的文件页：顶部是「聊天 | 文件名」页签，右边是直达新标签页的入口。
 * 页签把「看文件」和「回到对话」放在同一个位置，来回切换不需要记住从哪进来。
 */
export function WorkspacePreviewPane({
  projectId,
  chatId,
  path,
}: {
  projectId: string;
  chatId: string;
  path: string;
}) {
  const file = useChatFile(projectId, chatId);
  const name = path.split("/").pop() ?? path;
  const url = workspaceFileUrl({ projectId, chatId, path });
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-preview-pane">
      <div
        role="tablist"
        aria-label="中栏内容"
        className="flex min-h-15.25 shrink-0 items-center gap-1 border-b border-border px-3 max-desktop:min-h-19"
      >
        <button
          type="button"
          role="tab"
          aria-selected={false}
          data-testid="center-tab-chat"
          onClick={file.close}
          className="flex items-center gap-1.5 rounded-[var(--control-radius)] px-2 py-1 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <Icon as={MessageSquare} size={13} />
          聊天
        </button>
        <div
          role="tab"
          aria-selected
          className="flex min-w-0 items-center gap-1.5 rounded-[var(--control-radius)] bg-selected px-2 py-1 text-[12px]"
        >
          <span className="max-w-60 truncate">{name}</span>
          <button
            type="button"
            aria-label="关闭预览"
            title="关闭预览"
            onClick={file.close}
            className="inline-flex size-4 items-center justify-center rounded-[var(--control-radius)] text-muted-foreground hover:text-foreground"
          >
            <Icon as={X} size={12} />
          </button>
        </div>
        <div className="min-w-0 flex-1" />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          data-testid="preview-open-new-tab"
          className="flex items-center gap-1 rounded-[var(--control-radius)] px-2 py-1 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          新标签页打开
        </a>
      </div>
      <WorkspacePreview projectId={projectId} chatId={chatId} path={path} name={name} />
    </div>
  );
}
