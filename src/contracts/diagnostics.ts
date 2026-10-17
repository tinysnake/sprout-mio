/** 日志级别为封闭集合，禁止任意字符串级别。 */
export const DIAGNOSTIC_LEVELS = ["debug", "info", "warn", "error"] as const;
export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];
/** 基础关联字段必填，未出现的业务关联不能伪造为存在。at 使用 ISO 时间。 */
export interface DiagnosticEvent {
  id: string;
  at: string;
  level: DiagnosticLevel;
  event: string;
  requestId: string;
  projectId?: string;
  conversationId?: string;
  instanceId?: string;
  runId?: string;
  executionId?: string;
  message: string;
  data?: Record<string, unknown>;
}
