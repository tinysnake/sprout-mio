import type { AppError } from "../../contracts/result";

/** 领域错误按原码透出；`internal` 只留给真正的未知错误。 */
type DomainErrorCode = "not_found" | "conflict";
type DomainErrorClass = abstract new (...args: never[]) => Error & {
  code: string;
  message: string;
};

async function loadDomainErrorClasses(): Promise<readonly DomainErrorClass[]> {
  const [project, agent, access, chat, agentRun, repository] = await Promise.all([
    import("../../domain/project"),
    import("../../domain/agent"),
    import("../../domain/access"),
    import("../../domain/chat"),
    import("../../domain/agent-run"),
    import("../../domain/repository"),
  ]);
  return [
    project.ProjectError,
    agent.AgentError,
    access.ProjectAccessError,
    chat.ChatError,
    agentRun.AgentRunError,
    repository.RepositoryError,
  ];
}

function isDomainErrorCode(code: string): code is DomainErrorCode {
  return code === "not_found" || code === "conflict";
}

/**
 * 六个边界共用这一张映射表：not_found 与 conflict 按原码透出。
 * RepositoryError 的 repo_* 码不在封闭的 AppErrorCode 内，降为 conflict，
 * 可读的分类消息原样透出；`internal` 只留给真正的未知错误。
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
    if (error instanceof cls)
      return {
        code: isDomainErrorCode(error.code) ? error.code : "conflict",
        message: error.message,
        requestId,
      };
  }
  return undefined;
}
