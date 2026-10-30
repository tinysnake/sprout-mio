import type { ProjectContext } from "./access";

/**
 * 治理命令的行动者。人机的身份分成两个分支，Agent 必须带上自己那次运行的 `instanceId` 与
 * `runId`，权限判定不再看 `ctx.userId`：现有宿主把 `chat.createdBy` 当作执行上下文的 userId
 * 传入，只认 `ctx.userId` 的校验等于让分身冒充创建者。
 */
export type ChatActor =
  | {
      readonly kind: "human";
      readonly userId: string;
      readonly ctx: ProjectContext;
    }
  | {
      readonly kind: "agent";
      readonly agentProfileId: string;
      readonly instanceId: string;
      readonly runId: string;
      readonly ctx: ProjectContext;
    };

/**
 * 从调用上下文派生行动者：带 `ctx.agent` 就是那次运行，没带就是 Human。
 * 已有显式 `ChatActor` 形参的治理命令不用它；还没有 actor 形参的旧入口（标题写入）用它，
 * 让这些入口也走同一张能力表，而不是各自在调用点补一个 if。
 */
export function actorFromContext(ctx: ProjectContext): ChatActor {
  if (!ctx.agent) return { kind: "human", userId: ctx.userId, ctx };
  const { agentProfileId, instanceId, runId } = ctx.agent;
  return { kind: "agent", agentProfileId, instanceId, runId, ctx };
}
