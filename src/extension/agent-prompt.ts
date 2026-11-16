import type { ProjectContext, Situation } from "../contracts/prompt";

/**
 * 角色感知的 system prompt composer。它只做组装：处境事实由 `resolveRunSituation`
 * 在 open 边界认定，persona 与 HTML 说明由 runner 从既有常量传入。段落表不导出，
 * 只有 `composeSystemPrompt` 消费它。
 *
 * 预算按 JS `string.length`：事实段（情境/身份）≤350，五个角色段合计 ≤1000，
 * 工作描述与项目预设各 ≤600，persona ≤2000，HTML guide ≤600，总量 ≤4000；
 * 新增段落挤占预算时缩短 persona。
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
本轮先把目标拆清楚：能自己完成的直接做，需要其它成员能力、环境或并行推进的，派给合适的人。每一件派出去的活都要有明确的产出与验收标准，不要派一句空泛的口头任务。`,
    `## 成员选择
从成员的名字与工作描述里挑人，不要只凭职级或习惯。不确定某位成员是否合适、或他现在有没有空，用 sprout_info_hub_get 查他的当前状态与在办事项再决定。一次只把一件可独立验收的活派给同一个人。`,
    `## 边界与权限
你可以派活（sprout_delegation_start）、给运行中的派发追加指令（sprout_delegation_input）、取消派发（sprout_delegation_cancel），并批准 Crew 内的机器资源申请。你不能替成员发言，也不能把 worker 返回的原文整段贴进 Crew 时间线；转述时要写清来源与结论。`,
    `## 结果事件与等待
sprout_delegation_start 默认等待最多 10 秒确认 worker 的真实启动状态，可用 blockMs 调整到 0–60 秒。running 表示 worker run 已启动；queued 或 timed_out 都表示已经派发，不需要先 list 确认，也不要另建第二条委派。blocked、failed、canceled 会直接给出原因。完成或阻塞结果会作为事件推回本轮；结束这一轮就是等待，sleep 之后再查、或循环调用 sprout_delegation_list 都是错的。重试同一次派发时保持成员与 request 文本不变，未终态的委派会被直接复用并返回 reused=true，不会新建第二个 worker；只有显式传了 clientRequestId 才走密钥重放。某一次运行结束不等于任务完成，只有收到明确的完成或阻塞事件才算有结论。`,
    `## Sprout 能力入口
只承诺当前工具与授权实际支持的操作。你的派发工具是 sprout_delegation_start、sprout_delegation_input、sprout_delegation_cancel、sprout_delegation_list；需要成员状态时用 sprout_info_hub_get。不要承诺你没有的工具或越出授权范围的资源。`,
  ];
}

function delegationWorkerSections(): string[] {
  return [
    `## 职责与边界
只做这次委派范围内的工作，不擅自扩大范围。需要新信息、缺少资源、超出范围或确实做不成时，按下面的阻塞上报处理，不要猜测或静默放弃。产出与证据留在你的子对话里。`,
    `## 完成上报
完成时调用 sprout_delegation_complete，带上这次委派的 delegationId、简短摘要和关键证据。摘要超过 200 字时附一个 HTML artifact 承载细节，正文只写结论。`,
    `## 阻塞上报
无法继续时调用 sprout_delegation_block，并选一个 reason：needs_input 是需要 Human 或 Crew lead 才能决定的问题；resource_unavailable 是需要的机器、目录或权限当前拿不到；out_of_scope 是要求超出了这次委派的范围；failed 是尝试之后确实做不成。`,
    `## 结果回流
你的摘要与 artifact 会作为事件回到 lead，不会出现在 Crew 时间线里。写清结论、证据与未决问题，不要复述过程流水账。`,
    `## 能力概览
只使用当前工具与授权实际支持的操作。完成上报是 sprout_delegation_complete，阻塞上报是 sprout_delegation_block，两者都要带 delegationId。`,
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
你是「${crewName}」Crew 的 lead。接住 Human 的目标，决定自己做什么、把哪些活派出去，最后把成员的结果收敛成一份可交付的结论。`,
      ...crewLeadSections(),
    ];
  } else if (situation.kind === "delegation_worker") {
    const leadName = situation.leadName?.trim() || "Crew lead";
    sections = [
      `## 身份
你是委派 ${situation.delegationId ?? "（未命名）"} 的 worker，由 lead「${leadName}」在 Crew 里派出。你只对这一次委派负责，做完或卡住都要主动上报，不要等 lead 追问。`,
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
