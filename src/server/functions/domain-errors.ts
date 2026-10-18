import type { AppError } from "../../contracts/result";

/** 领域错误类的 code 联合是 AppErrorCode 的子集，原码透出在语义上安全。 */
type DomainErrorCode = "not_found" | "conflict";
type DomainErrorClass = abstract new (...args: never[]) => Error & {
  code: DomainErrorCode;
  message: string;
};

async function loadDomainErrorClasses(): Promise<readonly DomainErrorClass[]> {
  const [project, agent, access, conversation, agentRun] = await Promise.all([
    import("../../domain/project"),
    import("../../domain/agent"),
    import("../../domain/access"),
    import("../../domain/conversation"),
    import("../../domain/agent-run"),
  ]);
  return [
    project.ProjectError,
    agent.AgentError,
    access.ProjectAccessError,
    conversation.ConversationError,
    agentRun.AgentRunError,
  ];
}

/**
 * 五个边界共用这一张映射表：领域错误按原码透出，`internal` 只留给真正的未知错误。
 * 类加载失败时返回 undefined，让调用边界走它自己的 internal 分支而不是逃逸成未处理拒绝。
 */
export async function toDomainAppError(
  error: unknown,
  requestId: string,
): Promise<AppError | undefined> {
  let classes: readonly DomainErrorClass[];
  try {
    classes = await loadDomainErrorClasses();
  } catch {
    return undefined;
  }
  for (const cls of classes) {
    if (error instanceof cls) return { code: error.code, message: error.message, requestId };
  }
  return undefined;
}
