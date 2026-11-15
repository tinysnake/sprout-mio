import { Link, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { encodeOpenFiles } from "../../components/chat/chat-search";
import { Icon } from "../../components/ui/icon";
import { workspaceFileUrl } from "../../components/workspace/workspace-api";
import { WorkspacePreview } from "../../components/workspace/workspace-preview";

/**
 * 文件在新标签页里的样子：与中栏同一套预览器，满页显示。
 * 直接指向字节接口会让 md / csv 露出源码，所以这里是一个应用页面，
 * 原始字节仍在页脚的「下载」后面。
 */
export const Route = createFileRoute("/_authed/projects/$projectId/files")({
  validateSearch: z.object({ chatId: z.string().min(1), path: z.string().min(1) }),
  component: WorkspaceFilePage,
});

function WorkspaceFilePage() {
  const { projectId } = Route.useParams();
  const { chatId, path } = Route.useSearch();
  const name = path.split("/").pop() ?? path;
  const back = {
    projectId,
    chatId,
    info: 1 as const,
    pane: "files" as const,
    files: encodeOpenFiles([path]),
    file: path,
  };
  return (
    <section
      data-testid="workspace-file-page"
      className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col bg-background text-foreground"
    >
      <header className="flex min-h-15.25 shrink-0 items-center gap-3 border-b border-border px-4 max-desktop:min-h-19">
        <Link
          to="/projects/$projectId/chats/$chatId"
          params={{ projectId, chatId }}
          search={back}
          aria-label="回到对话"
          data-testid="workspace-file-back"
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 text-xs hover:text-primary"
        >
          <Icon as={ArrowLeft} size={14} />
          回到对话
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] tracking-[-0.2px]">{name}</h1>
          <p className="truncate text-[10px] text-muted-foreground">{path}</p>
        </div>
        <div className="min-w-0 flex-1" />
        <a
          href={workspaceFileUrl({ projectId, chatId, path })}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <Icon as={ExternalLink} size={12} />
          原始文件
        </a>
      </header>
      <WorkspacePreview projectId={projectId} chatId={chatId} path={path} name={name} />
    </section>
  );
}
