import { z } from "zod";
import { chatIdInput } from "./chat";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { FieldErrors } from "./project";
import type { RunRepoSnapshot } from "./repository";
import type { AppResult } from "./result";

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "aborted",
  "interrupted",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** 运行中活动的类别：只用于展示与图标，不参与 run 状态机。 */
export const RUN_ACTIVITY_KINDS = [
  "bash",
  "file",
  "mcp",
  "code_mode",
  "search",
  "remote",
  "task",
  "web",
  "tool",
  "system",
] as const;
export type RunActivityKind = (typeof RUN_ACTIVITY_KINDS)[number];
export type RunActivityStatus = "running" | "done" | "error";

/** 一次 run 的工作记录上限，防止长 run 无限占用进程内存。 */
export const RUN_ACTIVITY_ENTRY_LIMIT = 200;
/** 输入行的投递态；cancelled 记录扇出后被成员变更或人类停止取消的输入。 */
export type RunInputDisposition = "pending" | "delivered" | "cancelled";
export type RunInputCancelReason =
  | "membership_revoked"
  | "human_stop"
  | "group_dissolved"
  | "task_context_changed";

export type RunResourceSnapshot = {
  /** 宿主 skills 与 prompt templates 是否进入本轮 loader。 */
  inheritHostResources: boolean;
  /** 本轮 loader 的 agentDir：分身自己的受控目录，不是宿主 Pi 配置目录。 */
  agentDir: string;
  /** 宿主 Pi 配置目录：只用于凭据、模型目录与（开关打开时）skills/prompts。 */
  hostAgentDir: string;
  skillPaths: string[];
  promptPaths: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
  contextFiles: string[];
  systemPromptChars: number;
};

export type RunConfigSnapshot = {
  model: string;
  provider: string;
  thinking: string;
  tools: string[];
  /** registry 里注册的全部工具（含未加入 allowlist、未声明给模型的）。 */
  registeredTools?: string[];
  extensions: string[];
  sessionId: string;
  sessionFile: string;
  cwd: string;
  sdkVersion: string;
  /**
   * 本轮 Pi resource loader 的实际装载结果与继承开关状态。
   * 旧快照没有这一段字段，读取侧可选。
   */
  resources?: RunResourceSnapshot;
  /** 本轮实际使用的仓库工作副本与 commit；Project 未配置仓库时缺省。 */
  repo?: RunRepoSnapshot;
  profile: {
    id: string;
    name: string;
    persona: string;
    harness: "pi";
    model?: string;
    effort?: string;
    updatedAt: string;
  };
};

export type AgentRun = {
  id: string;
  instanceId: string;
  chatId: string;
  projectId: string;
  requestId: string;
  status: AgentRunStatus;
  queuedAt: string;
  startedAt?: string;
  settledAt?: string;
  stopReason?: string;
  errorCode?: string;
  errorMessage?: string;
  sessionId: string;
  configSnapshot?: RunConfigSnapshot;
  assistantMessageId?: string;
};

export type AgentRunInput = {
  runId: string;
  messageId: string;
  disposition: RunInputDisposition;
  admittedAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  cancelReason?: RunInputCancelReason;
};

export const runIdSchema = z.string().regex(appIdPattern(ID_PREFIXES.run));

export const abortAgentRunInput = z.object({ runId: runIdSchema });
export const chatRunStateInput = chatIdInput;

/**
 * 状态轮询需要的 run 字段：整行去掉 `configSnapshot`。
 * 配置快照只在诊断与验收里按需读，状态面板一个字段都不从它取。
 * `sessionFile` 是唯一从快照里提出来的值，验收脚本靠它定位 Pi 会话文件。
 */
export type ChatRunSummary = Omit<AgentRun, "configSnapshot"> & { sessionFile?: string };

/** 一条正在执行或刚结束的工具步骤；`detail` 是给人看的一句话摘要。 */
export type RunActivityStep = {
  id: string;
  kind: RunActivityKind;
  /** 动作名，例如「Bash 命令」「读取文件」「MCP 调用」。 */
  label: string;
  /** 命令首行、文件路径、查询词等摘要；无法摘要时缺省。 */
  detail?: string;
  /** 原始工具名，保留用于诊断与去重。 */
  toolName?: string;
  startedAt: string;
  finishedAt?: string;
  status: RunActivityStatus;
  durationMs?: number;
};

/**
 * 运行中的工作记录。它与 `status` 并列，不改变状态枚举：
 * status 回答「这个 run 处于哪个生命周期」，activity 回答「这一秒在做什么」。
 * 同一 run 的非 assistant 工作记录归为一组，由界面默认收起、只露出最后一条。
 */
export type RunActivity = {
  /** 正在执行的步骤；没有工具在跑时为 null。 */
  current: RunActivityStep | null;
  /** 本 run 的工作记录，最新在前；保留完整历史，上限见 RUN_ACTIVITY_ENTRY_LIMIT。 */
  entries: RunActivityStep[];
  updatedAt: string;
};

/** 活动 run 回答「有没有在跑、跑到哪个状态」，并按需带上即时活动。 */
export type ChatRunActiveRun = {
  id: string;
  status: AgentRunStatus;
  activity?: RunActivity;
};

export type ChatRunState = {
  enabled: boolean;
  /** 仍在排队或运行中的 run：每 tick 唯一需要观察的部分。 */
  active: ChatRunActiveRun[];
  /** 最近一条 run（任意状态）：状态标签、失败原因与输入投递态都读它。 */
  latest: ChatRunSummary | null;
  /** `latest` 的输入投递态。 */
  inputs: AgentRunInput[];
};

export type AgentRunResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
