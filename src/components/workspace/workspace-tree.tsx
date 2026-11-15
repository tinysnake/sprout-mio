import { useCallback, useEffect, useMemo, useState } from "react";
import { FileIcon, FolderClosed, FolderOpen, Loader2 } from "lucide-react";
import type { WorkspaceEntry } from "../../contracts/workspace";
import { Icon } from "../ui/icon";
import {
  Tree,
  TreeItem,
  TreeItemContent,
  TreeItemIndicator,
  TreeItemLabel,
  TreeItemTrigger,
} from "../ui/tree";
import { NewTabLink } from "./side-pane-tabs";
import { fetchWorkspaceTree, type WorkspaceQuery } from "./workspace-api";

/**
 * 目录树按展开逐层取：一次只发一个目录的请求，展开过的地方留在内存里，
 * 折叠不丢，切换文件不重取。失败的层保留错误文案，重试只重取那一层。
 */
type DirectoryState =
  | { status: "loading" }
  | { status: "ready"; entries: readonly WorkspaceEntry[]; truncated: boolean }
  | { status: "error"; message: string };

export function WorkspaceTreeView({
  projectId,
  chatId,
  selected,
  onOpen,
  onExpand,
  newTabHref,
  onRoot,
}: {
  projectId: string;
  chatId?: string;
  selected?: string;
  onOpen: (entry: WorkspaceEntry) => void;
  onExpand?: (path: string) => void;
  newTabHref: (entry: WorkspaceEntry) => string;
  onRoot?: (kind: "repository" | "workspace") => void;
}) {
  const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(
    () => new Map(),
  );
  const [expanded, setExpanded] = useState<string[]>([]);
  const [rootVersion, setRootVersion] = useState(0);

  const load = useCallback(
    async (path: string) => {
      setDirectories((current) => new Map(current).set(path, { status: "loading" }));
      try {
        const tree = await fetchWorkspaceTree({ projectId, chatId, path } as WorkspaceQuery);
        setDirectories((current) =>
          new Map(current).set(path, {
            status: "ready",
            entries: tree.entries,
            truncated: tree.truncated,
          }),
        );
        if (path === "") onRoot?.(tree.root);
      } catch (error) {
        setDirectories((current) =>
          new Map(current).set(path, {
            status: "error",
            message: error instanceof Error ? error.message : "读取失败",
          }),
        );
      }
    },
    [chatId, onRoot, projectId],
  );

  useEffect(() => {
    void load("");
  }, [load, rootVersion]);

  const toggle = useCallback(
    (next: string[]) => {
      setExpanded(next);
      for (const path of next)
        if (!directories.has(path)) {
          void load(path);
          onExpand?.(path);
        }
    },
    [directories, load, onExpand],
  );

  const renderLevel = (path: string): React.ReactNode => {
    const state = directories.get(path);
    if (!state) return null;
    if (state.status === "loading")
      return (
        <div className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground">
          <Icon as={Loader2} className="animate-spin" />
          读取中
        </div>
      );
    if (state.status === "error")
      return (
        <div className="flex flex-col items-start gap-1 px-2 py-1.5 text-destructive">
          <span>{state.message}</span>
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => void load(path)}
          >
            重试
          </button>
        </div>
      );
    if (state.entries.length === 0)
      return <div className="px-2 py-1.5 text-muted-foreground">空目录</div>;
    return (
      <>
        {state.entries.map((entry) => (
          <TreeItem
            key={entry.path}
            value={entry.path}
            label={entry.name}
            expandable={entry.kind === "directory"}
          >
            <TreeItemTrigger
              className="group w-full text-left"
              data-testid="workspace-tree-entry"
              data-workspace-path={entry.path}
              onClick={() => {
                if (entry.kind === "file") onOpen(entry);
              }}
            >
              <TreeItemIndicator className="text-muted-foreground">
                {entry.kind === "directory" ? (
                  expanded.includes(entry.path) ? (
                    <Icon as={FolderOpen} />
                  ) : (
                    <Icon as={FolderClosed} />
                  )
                ) : (
                  <Icon as={FileIcon} />
                )}
              </TreeItemIndicator>
              <TreeItemLabel className={entry.symlink ? "italic" : undefined}>
                {entry.name}
              </TreeItemLabel>
              {entry.kind === "file" && <NewTabLink href={newTabHref(entry)} name={entry.name} />}
            </TreeItemTrigger>
            {entry.kind === "directory" && (
              <TreeItemContent className="pl-3">
                {expanded.includes(entry.path) ? renderLevel(entry.path) : null}
              </TreeItemContent>
            )}
          </TreeItem>
        ))}
        {state.truncated && (
          <div className="px-2 py-1.5 text-muted-foreground">目录过大，只列出前一部分</div>
        )}
      </>
    );
  };

  const value = useMemo(() => (selected ? [selected] : []), [selected]);

  return (
    <div className="flex min-h-0 flex-col">
      <Tree
        selectionMode="single"
        value={value}
        expandedValue={expanded}
        onExpandedChange={(next) => toggle(next)}
        aria-label="工作区文件"
        className="min-h-0 flex-1 overflow-auto px-1 py-1"
      >
        {renderLevel("")}
      </Tree>
      {directories.get("")?.status === "error" && (
        <button
          type="button"
          className="mx-1 mb-1 self-start text-xs underline underline-offset-2"
          onClick={() => setRootVersion((value) => value + 1)}
        >
          重新加载工作区
        </button>
      )}
    </div>
  );
}
