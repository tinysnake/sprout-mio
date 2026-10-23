import type { AppError } from "../../contracts/result";

/** 领域错误按原码透出；`internal` 只留给真正的未知错误。 */
type DomainErrorCode = "not_found" | "conflict";
type DomainErrorClass = abstract new (...args: never[]) => Error & {
  code: string;
  message: string;
};

async function loadDomainErrorClasses(): Promise<readonly DomainErrorClass[]> {
  const [project, agent, access, chat, agentRun, repository, machine] = await Promise.all([
    import("../../domain/project"),
    import("../../domain/agent"),
    import("../../domain/access"),
    import("../../domain/chat"),
    import("../../domain/agent-run"),
    import("../../domain/repository"),
    import("../../domain/machine"),
  ]);
  return [
    project.ProjectError,
    agent.AgentError,
    access.ProjectAccessError,
    chat.ChatError,
    agentRun.AgentRunError,
    repository.RepositoryError,
    machine.MachineError,
  ];
}

function isDomainErrorCode(code: string): code is DomainErrorCode {
  return code === "not_found" || code === "conflict";
}

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
