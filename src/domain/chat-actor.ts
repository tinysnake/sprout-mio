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
