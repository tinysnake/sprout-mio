import { Link, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { encodeOpenFiles } from "../../components/chat/chat-search";
import { Icon } from "../../components/ui/icon";
import { fileUrlOf } from "../../components/workspace/workspace-api";
import { WorkspacePreview } from "../../components/workspace/workspace-preview";

/**
 * 机器上的文件在新标签页里的样子：与 Chat 右栏同一个预览器，满页显示。
 * 这里也是「新标签页打开」对 md / csv 的答案：直接指向字节接口会露出源码。
 */
export const Route = createFileRoute("/_authed/projects/$projectId/machines/$machineId/files")({
  validateSearch: z.object({
    path: z.string().min(1),
    chatId: z.string().min(1).optional(),
  }),
  component: MachineFilePage,
});

function MachineFilePage() {
  const { projectId, machineId } = Route.useParams();
  const { path, chatId } = Route.useSearch();
  const name = path.split("/").pop() ?? path;
  const source = { kind: "machine", projectId, machineId } as const;
  return (
    <section
      data-testid="machine-file-page"
      className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col bg-background text-foreground"
    >
      <header className="flex min-h-15.25 shrink-0 items-center gap-3 border-b border-border px-4 max-desktop:min-h-19">
        {chatId ? (
          <Link
            to="/projects/$projectId/chats/$chatId"
            params={{ projectId, chatId }}
            search={{
              info: 1 as const,
              pane: "files" as const,
              machine: machineId,
              files: encodeOpenFiles([path]),
              file: path,
            }}
            aria-label="回到对话"
            data-testid="machine-file-back"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 text-xs hover:text-primary"
          >
            <Icon as={ArrowLeft} size={14} />
            回到对话
          </Link>
        ) : (
          <Link
            to="/machines/$machineId"
            params={{ machineId }}
            aria-label="回到机器"
            data-testid="machine-file-back"
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 text-xs hover:text-primary"
          >
            <Icon as={ArrowLeft} size={14} />
            回到机器
          </Link>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-[15px] tracking-[-0.2px]">{name}</h1>
          <p className="truncate text-[10px] text-muted-foreground">{path}</p>
        </div>
        <div className="min-w-0 flex-1" />
        <a
          href={fileUrlOf(source, path)}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <Icon as={ExternalLink} size={12} />
          原始文件
        </a>
      </header>
      <WorkspacePreview source={source} path={path} name={name} />
    </section>
  );
}
