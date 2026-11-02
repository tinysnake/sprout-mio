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

/** 活动 run 只回答「有没有在跑、跑到哪个状态」：页面既不用它的配置快照，也不用它的时间线。 */
export type ChatRunActiveRun = {
  id: string;
  status: AgentRunStatus;
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
