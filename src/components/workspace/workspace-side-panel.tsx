import { useState } from "react";
import { ArrowLeft, FolderTree, PanelRightClose } from "lucide-react";
import type { WorkspaceEntry } from "../../contracts/workspace";
import { useChatFile, useChatSidePane, type ChatSidePane } from "../chat/chat-search";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { SidePaneTabs } from "./side-pane-tabs";
import { workspaceViewerUrl } from "./workspace-api";
import { WorkspaceTreeView } from "./workspace-tree";

const ROOT_LABEL = {
  repository: "Project 工作副本",
  workspace: "Chat 工作区",
} as const;

/**
 * 文件面板只做两件事：浏览与打开。预览在中栏，新标签页靠行尾那个按钮，
 * 两者共用同一个 URL，参数一字不差。
 */
export function WorkspaceSidePanel({
  projectId,
  chatId,
  onClose,
}: {
  projectId: string;
  chatId: string;
  onClose: () => void;
}) {
  const { pane, setPane } = useChatSidePane(projectId, chatId);
  const file = useChatFile(projectId, chatId);
  const [root, setRoot] = useState<"repository" | "workspace" | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-panel">
      <header className="flex min-h-15.25 items-center gap-2 border-b border-border px-5 max-desktop:min-h-19 max-desktop:px-3 max-desktop:py-3.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="返回聊天"
          title="返回聊天"
          onClick={onClose}
          className="hidden max-desktop:inline-flex"
        >
          <Icon as={ArrowLeft} />
        </Button>
        <SidePaneTabs pane={pane} onChange={setPane} />
        <div className="min-w-0 flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="收起侧栏"
          title="收起侧栏"
          onClick={onClose}
          className="max-desktop:hidden"
        >
          <Icon as={PanelRightClose} />
        </Button>
      </header>
      <div className="flex shrink-0 items-center gap-1.5 px-5 pt-3 text-[10px] text-muted-foreground">
        <Icon as={FolderTree} size={12} />
        {root ? ROOT_LABEL[root] : "工作区"}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspaceTreeView
          projectId={projectId}
          chatId={chatId}
          selected={file.file}
          onRoot={setRoot}
          onOpen={(entry: WorkspaceEntry) => file.open(entry.path)}
          newTabHref={(entry) => workspaceViewerUrl({ projectId, chatId, path: entry.path })}
        />
      </div>
    </div>
  );
}

export type { ChatSidePane };
