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
export type RunInputDisposition = "pending" | "delivered";

export type RunConfigSnapshot = {
  model: string;
  provider: string;
  thinking: string;
  tools: string[];
  extensions: string[];
  sessionId: string;
  sessionFile: string;
  cwd: string;
  sdkVersion: string;
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
  deliveredAt?: string;
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
