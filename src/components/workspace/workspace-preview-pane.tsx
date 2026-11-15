import { useEffect, useRef, type ReactNode } from "react";
import { MessageSquare, SquareArrowOutUpRight, X } from "lucide-react";
import { cn } from "cn";
import { useChatFile } from "../chat/chat-search";
import { InspectorButtons } from "../chat/inspector-buttons";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { workspaceViewerUrl } from "./workspace-api";
import { WorkspacePreview } from "./workspace-preview";

const NAME_OF = (path: string) => path.split("/").pop() ?? path;

/**
 * 中栏的文件区：「聊天」页签常驻，每个打开过的文件各占一个页签。
 * 页签列表跟着 URL 走，切回聊天不会丢掉文件页签；关闭某个文件才真的移除。
 * 页签多了只滚动页签条，右侧的按钮不跟着滚走。
 */
export function WorkspacePreviewPane({
  projectId,
  chatId,
  inspectorOpen,
  filesOpen,
  onToggleInspector,
  onToggleFiles,
  children,
}: {
  projectId: string;
  chatId: string;
  /** 聊天标题栏被预览顶掉后，这两个入口还要在，所以页签栏复用同一组按钮。 */
  inspectorOpen: boolean;
  filesOpen: boolean;
  onToggleInspector: () => void;
  onToggleFiles: () => void;
  /** 聊天本身：点「聊天」页签时原地显示，不换路由也不卸载对话。 */
  children: ReactNode;
}) {
  const { file, files, activate, closeTab } = useChatFile(projectId, chatId);
  // 旧链接可能只带 `file` 不带 `files`：当前文件始终算一个页签。
  const tabs = file && !files.includes(file) ? [...files, file] : files;
  const list = useRef<HTMLDivElement>(null);

  // 换到被滚出视口的页签时把它带回来，不然选中了却看不见。
  useEffect(() => {
    list.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [file]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-preview-pane">
      <div className="flex min-h-15.25 shrink-0 items-center gap-1 border-b border-border px-3 max-desktop:min-h-19">
        <div
          ref={list}
          role="tablist"
          aria-label="中栏内容"
          data-testid="center-tab-list"
          onWheel={(event) => {
            // 页签条是横向的：滚轮在它上面就横向滚，不把页面跟着推走。
            const element = list.current;
            if (!element || element.scrollWidth <= element.clientWidth) return;
            if (event.deltaY === 0) return;
            element.scrollLeft += event.deltaY;
          }}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:thin]"
        >
          <CenterTab
            active={!file}
            testId="center-tab-chat"
            onClick={() => activate(undefined)}
            label="聊天"
            icon={<Icon as={MessageSquare} size={13} />}
          />
          {tabs.map((path) => (
            <CenterTab
              key={path}
              active={path === file}
              testId="center-tab-file"
              dataPath={path}
              onClick={() => activate(path)}
              onClose={() => closeTab(path)}
              label={NAME_OF(path)}
              title={path}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {file && (
            <Button
              variant="ghost"
              size="icon"
              nativeButton={false}
              render={
                <a
                  href={workspaceViewerUrl({ projectId, chatId, path: file })}
                  target="_blank"
                  rel="noreferrer"
                />
              }
              data-testid="preview-open-new-tab"
              aria-label="新标签页打开"
              title="新标签页打开"
            >
              <Icon as={SquareArrowOutUpRight} />
            </Button>
          )}
          <InspectorButtons
            inspectorOpen={inspectorOpen}
            onToggleInspector={onToggleInspector}
            filesOpen={filesOpen}
            onToggleFiles={onToggleFiles}
          />
        </div>
      </div>
      {file ? (
        <WorkspacePreview
          key={file}
          projectId={projectId}
          chatId={chatId}
          path={file}
          name={NAME_OF(file)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      )}
    </div>
  );
}

function CenterTab({
  active,
  label,
  title,
  icon,
  testId,
  dataPath,
  onClick,
  onClose,
}: {
  active: boolean;
  label: string;
  title?: string;
  icon?: ReactNode;
  testId: string;
  dataPath?: string;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-[var(--control-radius)] px-2 py-1 text-[12px]",
        active
          ? "bg-selected text-foreground"
          : "text-muted-foreground hover:bg-hover hover:text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-testid={testId}
        data-workspace-path={dataPath}
        title={title ?? label}
        onClick={onClick}
        className="flex min-w-0 items-center gap-1.5"
      >
        {icon}
        <span className="max-w-40 truncate">{label}</span>
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`关闭 ${label}`}
          title={`关闭 ${label}`}
          onClick={onClose}
          className="inline-flex size-4 items-center justify-center rounded-[var(--control-radius)] text-muted-foreground hover:text-foreground"
        >
          <Icon as={X} size={12} />
        </button>
      )}
    </div>
  );
}
