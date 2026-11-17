import type { ProjectContext, Situation } from "../contracts/prompt";

/**
 * 角色感知的 system prompt composer。处境由 `resolveRunSituation` 在 open 边界认定，
 * persona 与 HTML 说明由 runner 传入。
 *
 * 预算按 JS `string.length`：工作描述 ≤500，persona ≤2000，HTML 段 ≤600，
 * 总量 ≤4000。情境名称无长度上限，仍需按剩余预算裁剪 persona。
 */
type PromptFacts = {
  situation: Situation;
  projectContext?: ProjectContext;
  profile?: { description?: string };
  persona: string;
  htmlGuide: string;
};

function crewLeadSections(): string[] {
  return [
    `## 职责
先拆目标；能自做则自做，需要成员能力、环境或并行则委派，明确产出与验收标准。`,
    `## 成员选择
按名字与工作描述挑人，勿凭职级或习惯；适配或空闲不明时，用 sprout_info_hub_get 查当前状态与在办事项。每人一次一件可独立验收的活。`,
    `## 边界与权限
可用 sprout_delegation_start 派活、sprout_delegation_input 追加运行中指令、sprout_delegation_cancel 取消，并批准 Crew 内机器资源申请。勿替成员发言或整段贴 worker 原文到 Crew 时间线；转述注明来源与结论。`,
    `## 结果事件与等待
start 默认等真实启动最多10秒，blockMs 可设0–60秒；running=run已启动，queued/timed_out=已派发，无需 list 确认或另建委派；blocked/failed/canceled 附原因。完成/阻塞事件自动回推；结束这一轮就是等待，sleep 后查或循环调用 sprout_delegation_list 都是错的。重试同次派发保持成员与 request 文本不变，未终态复用并返回 reused=true，不另建 worker；仅显式 clientRequestId 走密钥重放。run结束≠任务完成，明确完成/阻塞事件才是结论。`,
    `## Sprout 能力入口
只承诺当前工具与授权支持的操作、资源。`,
  ];
}

function delegationWorkerSections(): string[] {
  return [
    `## 职责与边界
限本次委派与已授权工具；产出证据留子对话。缺信息/资源、越界/做不成即报阻塞，勿猜测/静默放弃。`,
    `完成→sprout_delegation_complete：短摘要/关键证据；摘要>200字附 HTML artifact 详述，正文仅结论。`,
    `阻塞→sprout_delegation_block，reason：needs_input=Human 或 Crew lead 决定；resource_unavailable=缺机器/目录/权限；out_of_scope=越本次范围；failed=尝试后失败。`,
    `摘要/artifact 事件回 lead，不进 Crew 时间线；列结论/证据/未决问题，勿流水账。`,
    `两种上报均带本次 delegationId；勿等 lead 追问。`,
  ];
}

/**
 * 按处境组装 system prompt。只处理 crew_lead 与 delegation_worker 两个新角色；
 * 其余处境由 runner 回落到旧的组装，所以这里直接拒绝，避免悄悄产出一份半成品。
 */
export function composeSystemPrompt(facts: PromptFacts): string {
  const { situation, persona, htmlGuide } = facts;
  let sections: string[];
  if (situation.kind === "crew_lead") {
    const crewName = situation.crewName?.trim() || "当前 Crew";
    sections = [
      `## 情境
你是「${crewName}」Crew lead：接 Human 目标，自做或委派，收敛成员结果为可交付结论。`,
      ...crewLeadSections(),
    ];
  } else if (situation.kind === "delegation_worker") {
    const leadName = situation.leadName?.trim() || "Crew lead";
    sections = [
      `## 身份
委派${situation.delegationId ?? "（未命名）"} worker；Crew lead「${leadName}」派出。`,
      ...delegationWorkerSections(),
    ];
  } else {
    throw new Error(
      `composeSystemPrompt 只支持 crew_lead 与 delegation_worker，收到 ${situation.kind}`,
    );
  }
  const description = facts.profile?.description?.trim();
  if (description) sections.push(`## 工作描述\n${description.slice(0, 500)}`);
  const kind = facts.projectContext?.kind;
  if (kind === "coding" || kind === "work") {
    const preset =
      kind === "coding"
        ? "这是一个编程项目。先阅读项目约定与相关实现，修改后运行与变更相称的验证，交付可复核的代码与证据。"
        : "这是一个工作项目。明确目标、依据与交付标准，整理信息并推进执行；结论注明证据、责任人与未决事项。";
    sections.push(`## 项目背景\n${preset}\n以下补充要求与本节默认指引冲突时，以补充要求为准`);
  }
  const html = htmlGuide.trim() ? `## HTML 交付\n${htmlGuide.trim()}`.slice(0, 600) : "";
  const remaining =
    4000 - sections.join("\n\n").length - (html ? html.length + 2 : 0) - "\n\n## 说话风格\n".length;
  if (persona.trim())
    sections.push(
      `## 说话风格\n${persona.trim().slice(0, Math.max(0, Math.min(2000, remaining)))}`,
    );
  if (html) sections.push(html);
  return sections.join("\n\n");
}
