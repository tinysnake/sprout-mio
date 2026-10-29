import { ID_PREFIXES, newId } from "../contracts/ids";
import { db, sqlite } from "../db";
import { agentProfile, diagnosticEvent, project, projectMember } from "../db/schema";
import { ensureProjectChannel } from "./channel";

/**
 * 默认 Agent 的固定内容。model 与 effort 留空，运行时沿用宿主 Pi 的默认值，
 * 因此这里不写入任何占位取值。
 */
const DEFAULT_PROJECT_NAME = "我的项目";
const DEFAULT_AGENT_NAME = "Amenda";
const DEFAULT_AGENT_JOB_TITLE = "全能秘书";
const DEFAULT_AGENT_PERSONA = [
  "随和明快，说话简短。",
  "主动接住杂事，把待办和上下文整理清楚。",
  "需要判断的事先问，不替人做决定。",
].join("\n");

export type BootstrapResult = {
  projectId: string;
  agentProfileId: string;
  requestId: string;
};

/**
 * 注册成功后调用。Project、它的公共频道、默认 Agent profile 和成员关系在同一个事务里写入，
 * 任一步失败整体回滚，不留只有 Project 没有成员的半成品。
 *
 * 调用方是 better-auth 的 create.after 钩子，此时注册事务已经提交，这里另开事务不构成嵌套。
 * 播种失败向上抛出，由调用方决定是否让注册成功继续，不在此静默吞掉。
 */
export function createDefaultProjectForHuman(
  userId: string,
  requestId: string,
  now: Date = new Date(),
): BootstrapResult {
  return sqlite.transaction(() => {
    const at = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const projectId = newId(ID_PREFIXES.project);
    const agentProfileId = newId(ID_PREFIXES.agentProfile);

    db.insert(project)
      .values({
        id: projectId,
        name: DEFAULT_PROJECT_NAME,
        description: null,
        createdBy: userId,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    db.insert(agentProfile)
      .values({
        id: agentProfileId,
        name: DEFAULT_AGENT_NAME,
        jobTitle: DEFAULT_AGENT_JOB_TITLE,
        persona: DEFAULT_AGENT_PERSONA,
        harness: "pi",
        model: null,
        effort: null,
        createdBy: userId,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    db.insert(projectMember)
      .values({ projectId, agentProfileId, addedBy: userId, addedAt: at })
      .run();

    // 注册时建的 Project 与手动新建的一样带着自己的公共频道；频道成员随 Project 成员派生，
    // 所以这里不写任何 chat_member 行。
    ensureProjectChannel(projectId);

    db.insert(diagnosticEvent)
      .values({
        id: newId(ID_PREFIXES.diagnostic),
        at,
        level: "info",
        event: "project.default_created",
        requestId,
        projectId,
        message: "默认 Project 与默认 Agent 已创建",
        data: JSON.stringify({ agentProfileId, name: DEFAULT_PROJECT_NAME }),
      })
      .run();

    return { projectId, agentProfileId, requestId };
  })();
}

/** 供测试与文档引用，避免默认文案在多处重复。 */
export const defaultProjectSeed = {
  projectName: DEFAULT_PROJECT_NAME,
  agentName: DEFAULT_AGENT_NAME,
  jobTitle: DEFAULT_AGENT_JOB_TITLE,
  persona: DEFAULT_AGENT_PERSONA,
} as const;
