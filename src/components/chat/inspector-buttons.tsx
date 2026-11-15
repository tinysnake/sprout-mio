import { FolderTree, PanelRight, PanelRightClose } from "lucide-react";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/**
 * 聊天标题栏里的两个入口：工作区文件与对话详情。
 * 中栏换成文件预览时聊天标题栏不在了，预览页签栏复用同一组按钮，
 * 否则看文件时就没有回文件树或详情的入口。
 */
export function InspectorButtons({
  inspectorOpen,
  onToggleInspector,
  filesOpen = false,
  onToggleFiles,
}: {
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
}) {
  return (
    <>
      {onToggleFiles && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="toggle-workspace-files"
          aria-label="工作区文件页签"
          title="工作区文件"
          aria-pressed={filesOpen}
          onClick={onToggleFiles}
          className={filesOpen ? "bg-selected text-foreground" : undefined}
        >
          <Icon as={FolderTree} />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid="toggle-inspector"
        aria-label={inspectorOpen ? "关闭会话详情" : "打开会话详情"}
        title="会话详情"
        aria-expanded={inspectorOpen}
        aria-controls="info-hub"
        onClick={onToggleInspector}
      >
        <Icon as={inspectorOpen ? PanelRightClose : PanelRight} />
      </Button>
    </>
  );
}
