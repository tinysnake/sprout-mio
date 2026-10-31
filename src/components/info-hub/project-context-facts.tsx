import { Link } from "@tanstack/react-router";
import { projectInfoHubSchema, type ProjectInfoHub } from "../../contracts/info-hub";
import { ProjectAgentsPanel } from "./project-agents-panel";
import { MachineSummaryFact } from "./basic-facts";

/** Context facts belong on existing Project settings and Machine lease pages. */
export function ProjectContextFacts({
  info,
  machineId,
}: {
  info: ProjectInfoHub;
  machineId?: string;
}) {
  if (!projectInfoHubSchema.safeParse(info).success)
    return (
      <p role="alert" className="text-[11px] text-destructive">
        Project 事实读取失败：返回数据不符合 Info Hub 契约。
      </p>
    );
  const machines = machineId
    ? info.machines.filter((machine) => machine.machineId === machineId)
    : info.machines;
  return (
    <details
      data-testid="info-hub-project-context"
      className="min-w-0 border-b border-border pb-4"
      open
    >
      <summary className="cursor-pointer text-xs font-medium">
        {info.projectName} · {machineId ? "Machine 与 Project 事实" : "Project 摘要"}
      </summary>
      <div className="min-w-0 space-y-4 pt-4">
        <ProjectAgentsPanel projectId={info.projectId} view={info.agents} />
        <section data-testid="info-project-chats" className="space-y-2 text-[11px]">
          <h3 className="font-medium">Chats 摘要</h3>
          {info.chats.length === 0 ? (
            <p className="text-muted-foreground">这个 Project 还没有 Chat。</p>
          ) : (
            info.chats.map((chat) => (
              <p key={chat.chatId} className="break-words">
                <Link
                  to="/projects/$projectId/chats/$chatId"
                  params={{ projectId: info.projectId, chatId: chat.chatId }}
                  className="underline"
                >
                  {chat.displayTitle || chat.kind}
                </Link>{" "}
                · {chat.memberCount} 位成员 · 本 Chat 活动 run {chat.activeRunIds.length} 条
                {chat.archived ? " · 已归档" : ""}
              </p>
            ))
          )}
        </section>
        <section data-testid="info-project-tasks" className="space-y-2 text-[11px]">
          <h3 className="font-medium">Tasks 摘要</h3>
          <p className="text-muted-foreground">
            待分派 {info.tasks.counts.proposed} · 已分派 {info.tasks.counts.assigned} · 已完成{" "}
            {info.tasks.counts.finished} · 已取消 {info.tasks.counts.canceled}
          </p>
        </section>
        <section data-testid="info-project-machines" className="min-w-0 space-y-2">
          <h3 className="text-xs font-medium">{machineId ? "本 Machine" : "Machine 占用摘要"}</h3>
          {machines.length === 0 ? (
            <p data-testid="info-machines-empty" className="text-[11px] text-muted-foreground">
              本 Project 没有关联的 Machine，无 Machine 租约。
            </p>
          ) : (
            machines.map((machine) => (
              <MachineSummaryFact key={machine.machineId} machine={machine} />
            ))
          )}
        </section>
      </div>
    </details>
  );
}
