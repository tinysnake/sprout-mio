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
拆目标、定产出与验收；自做或按能力/环境/并行需要委派。`,
    `## 成员选择
按名字与工作描述挑人，勿凭职级或习惯；不明用 sprout_info_hub_get 查适配/空闲/在办事项。每人一次一项独立验收。`,
    `## 边界与权限
sprout_delegation_start 派活、sprout_delegation_input 追加运行指令、sprout_delegation_cancel 取消；可批 Crew 机器资源。勿代言/整贴 worker 原文到 Crew；转述标来源/结论；只承诺工具/授权内能力。`,
    `## 事件与等待
start 默认等启动10秒，blockMs=0–60秒；running=已启动，queued/timed_out=已派发，勿 list/重派；blocked/failed/canceled 带原因。完成/阻塞自动回推；结束这一轮就是等待，sleep 后查或循环调用 sprout_delegation_list 都是错的。重试同次派发保持成员与 request 文本不变，未终态复用 worker，reused=true；仅显式 clientRequestId 重放。run结束≠完成，以完成/阻塞事件为准。`,
  ];
}

function delegationWorkerSections(): string[] {
  return [
    `## 职责与边界
限本次委派/授权，证据留子对话；受阻即报，勿猜测/静默放弃。`,
    `完成→sprout_delegation_complete：摘要>200字附 HTML artifact，正文仅结论。`,
    `阻塞→sprout_delegation_block：needs_input=Human 或 Crew lead 决定；resource_unavailable=缺机器/目录/权限；out_of_scope=越界；failed=尝试失败。`,
    `回 lead，勿进 Crew；上报含本次 delegationId、结论/证据/未决，勿流水账/等追问。`,
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
「${crewName}」Crew lead：接 Human 目标并汇总交付。`,
      ...crewLeadSections(),
    ];
  } else if (situation.kind === "delegation_worker") {
    const leadName = situation.leadName?.trim() || "Crew lead";
    sections = [
      `## 身份
worker ${situation.delegationId ?? "（未命名）"}；lead「${leadName}」。`,
      ...delegationWorkerSections(),
    ];
  } else {
    throw new Error(
      `composeSystemPrompt 只支持 crew_lead 与 delegation_worker，收到 ${situation.kind}`,
    );
  }
  sections.push("更多工具用tool_search找");
  const description = facts.profile?.description?.trim();
  if (description) sections.push(`## 工作描述\n${description.slice(0, 500)}`);
  const kind = facts.projectContext?.kind;
  if (kind === "coding" || kind === "work") {
    const preset =
      kind === "coding"
        ? "编程项目。读约定/实现；改后做相称验证，交付可核代码/证据。"
        : "工作项目。明确目标、依据与交付标准，整理信息并推进执行；结论注明证据、责任人与未决事项。";
    sections.push(`## 项目背景\n${preset}\n补充要求优先于本节`);
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
