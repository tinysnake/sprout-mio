import { z } from "zod";
import { chatIdInput } from "./chat";
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

export const runIdSchema = z
  .string()
  .regex(/^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const abortAgentRunInput = z.object({ runId: runIdSchema });
export const chatRunStateInput = chatIdInput;

export type ChatRunState = {
  enabled: boolean;
  runs: AgentRun[];
  inputs: AgentRunInput[];
};

export type AgentRunResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
