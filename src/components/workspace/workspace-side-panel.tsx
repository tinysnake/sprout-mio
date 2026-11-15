import { useState } from "react";
import { ArrowLeft, FolderTree, PanelRightClose, RotateCcw } from "lucide-react";
import type { WorkspaceEntry } from "../../contracts/workspace";
import {
  useChatFile,
  useChatSidePane,
  useMachineBrowse,
  type ChatSidePane,
} from "../chat/chat-search";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { SidePaneTabs } from "./side-pane-tabs";
import { viewerUrlOf, type WorkspaceSource } from "./workspace-api";
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
  machineId,
  machineNames,
  onClose,
}: {
  projectId: string;
  chatId: string;
  /** 给了就浏览那台机器上的项目目录，否则看 Chat 自己的工作区。 */
  machineId?: string;
  /** 名单来自 Project 的机器投影：树还没回话时标题也能写出机器名。 */
  machineNames?: Readonly<Record<string, string>>;
  onClose: () => void;
}) {
  const { pane, setPane } = useChatSidePane(projectId, chatId);
  const file = useChatFile(projectId, chatId);
  const [root, setRoot] = useState<"repository" | "workspace" | null>(null);
  const [machineName, setMachineName] = useState<string | null>(
    machineId ? (machineNames?.[machineId] ?? null) : null,
  );
  const browse = useMachineBrowse(projectId, chatId);
  const source: WorkspaceSource = machineId
    ? { kind: "machine", projectId, machineId }
    : { kind: "workspace", projectId, chatId };

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
        <span className="min-w-0 truncate">
          {machineId ? `机器：${machineName ?? machineId}` : root ? ROOT_LABEL[root] : "工作区"}
        </span>
        {machineId && (
          <button
            type="button"
            onClick={() => browse(undefined)}
            data-testid="workspace-source-clear"
            className="ml-auto shrink-0 underline underline-offset-2 hover:text-foreground"
          >
            <Icon as={RotateCcw} size={11} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspaceTreeView
          source={source}
          selected={file.file}
          onRoot={setRoot}
          onMachineName={setMachineName}
          onOpen={(entry: WorkspaceEntry) => file.open(entry.path)}
          newTabHref={(entry) => viewerUrlOf(source, entry.path, chatId)}
        />
      </div>
    </div>
  );
}

export type { ChatSidePane };
